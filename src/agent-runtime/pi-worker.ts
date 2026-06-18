import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentWorker, WakeEnvelope } from "./worker.js";
import type { MailDeliveredEvent, Provider } from "../types.js";
import { buildPiMailTools } from "./pi-mail-tools.js";
import { buildPiModelConfig } from "./pi-model.js";
import { sanitizeMailFrom } from "./sanitize-from.js";

function isMailDeliveredEvent(event: string | MailDeliveredEvent): event is MailDeliveredEvent {
  return typeof event === "object" && event.type === "mail.delivered";
}

function wakePrompt(wake: WakeEnvelope): string {
  const mail = [...wake.events].reverse().find(isMailDeliveredEvent);
  if (!mail) {
    return "You received a Team Room wake notification. First check unread mail with mail_list({ unreadOnly: true }), then read relevant messages with mail_get. Reply in-thread with mail_reply when responding to a request, or use mail_send for a new thread. If a coding task is requested, inspect and edit the mounted codebase as needed. If nothing is actionable, end your turn without sending mail.";
  }
  const from = sanitizeMailFrom(mail.from);
  if (mail.replyExpected) {
    return `You received Team Room mail that requires a reply. Message id: ${mail.messageId}. Thread id: ${mail.threadId}. From: ${from}. Read it with mail_get, do any needed work, then reply in-thread with mail_reply. Final assistant text is diagnostic only and is not delivered to Team Room.`;
  }
  return `You received Team Room mail with no required reply. Message id: ${mail.messageId}. Thread id: ${mail.threadId}. From: ${from}. Read it with mail_get if useful. Send mail only if doing so adds value; otherwise end without replying.`;
}

const TEAMROOM_APPEND_PROMPT = `You run inside Team Room as a general coding teammate.
On every wake, check unread Team Room mail first.
Use mail_reply for in-thread responses and mail_send only for new threads.
Your working directory is /codebase when present. Use read, write, edit, and bash for coding tasks.
Do not expose secrets or credentials.`;

const TEAMROOM_PI_MAIL_TOOL_NAMES = [
  "mail_list",
  "mail_get",
  "mail_send",
  "mail_reply",
  "mail_mark_read",
  "mail_archive",
  "mail_delete",
] as const;

interface PiSessionLike {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
}

export interface PiAgentWorkerTestOpts {
  createSession: () => Promise<PiSessionLike>;
  onText?: (text: string) => void;
  onError?: (err: unknown) => void;
}

interface PiAgentWorkerOpts extends PiAgentWorkerTestOpts {
  createSession: () => Promise<PiSessionLike>;
}

export class PiAgentWorker implements AgentWorker {
  private readonly session: PiSessionLike;
  private readonly onError?: (err: unknown) => void;
  private readonly unsubscribe: () => void;

  private constructor(session: PiSessionLike, opts: { onText?: (text: string) => void; onError?: (err: unknown) => void }) {
    this.session = session;
    this.onError = opts.onError;
    this.unsubscribe = session.subscribe((event) => {
      const delta = textDeltaFromEvent(event);
      if (delta !== undefined) opts.onText?.(delta);
    });
  }

  static async create(): Promise<PiAgentWorker> {
    return PiAgentWorker.build({
      createSession: createProductionSession,
      onText: (text) => process.stderr.write(`[pi] ${text}`),
      onError: (err) => process.stderr.write(`[pi-error] ${err instanceof Error ? err.message : String(err)}\n`),
    });
  }

  static async createForTest(opts: PiAgentWorkerTestOpts): Promise<PiAgentWorker> {
    return PiAgentWorker.build(opts);
  }

  private static async build(opts: PiAgentWorkerOpts): Promise<PiAgentWorker> {
    const session = await opts.createSession();
    return new PiAgentWorker(session, opts);
  }

  async handleWake(wake: WakeEnvelope): Promise<void> {
    try {
      await this.session.prompt(wakePrompt(wake));
    } catch (err) {
      this.onError?.(err);
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.session.dispose();
  }
}

function textDeltaFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const maybe = event as { type?: unknown; assistantMessageEvent?: unknown };
  if (maybe.type !== "message_update") return undefined;
  const assistant = maybe.assistantMessageEvent;
  if (!assistant || typeof assistant !== "object") return undefined;
  const update = assistant as { type?: unknown; delta?: unknown };
  if (update.type !== "text_delta" || typeof update.delta !== "string") return undefined;
  return update.delta;
}

async function createProductionSession(): Promise<AgentSession> {
  const provider = requireProvider();
  const model = requireEnv("TEAMROOM_MODEL");
  const baseUrl = requireEnv("TEAMROOM_MODEL_BASE_URL");
  const apiToken = requireEnv("TEAMROOM_MODEL_API_TOKEN");
  const mcpUrl = requireEnv("TEAMROOM_MCP_URL");
  const mcpToken = requireEnv("TEAMROOM_MCP_TOKEN");

  const cwd = existsSync("/codebase") ? "/codebase" : "/store";
  const agentDir = "/store/pi-agent";
  mkdirSync(agentDir, { recursive: true });

  const piModel = buildPiModelConfig({ provider, model, baseUrl, apiToken });
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify(piModel.modelsJson, null, 2));

  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
  const resolvedModel = modelRegistry.find(piModel.providerId, piModel.modelId);
  if (!resolvedModel) {
    throw new Error(`Pi model not found: ${piModel.providerId}/${piModel.modelId}`);
  }

  const mailExtension: ExtensionFactory = (pi) => {
    for (const mailTool of buildPiMailTools({ mcpUrl, mcpToken })) {
      pi.registerTool(mailTool);
    }
  };

  const agentsContent = existsSync("/AGENTS.md") ? readFileSync("/AGENTS.md", "utf8") : "";
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [mailExtension],
    agentsFilesOverride: () => ({
      agentsFiles: [{ path: "/AGENTS.md", content: agentsContent }],
    }),
    appendSystemPromptOverride: (base) => [...base, TEAMROOM_APPEND_PROMPT],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: resolvedModel,
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: resolvePiAllowedTools(process.env.TEAMROOM_ALLOWED_TOOLS),
    sessionManager: SessionManager.inMemory(cwd),
  });
  return session;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireProvider(): Provider {
  const value = requireEnv("TEAMROOM_PROVIDER");
  if (value !== "openrouter") {
    throw new Error(`unsupported TEAMROOM_PROVIDER for PiAgentWorker: ${value}`);
  }
  return value;
}

export function resolvePiAllowedTools(value: string | undefined): string[] {
  const mapped = (value ?? "read,write,edit,bash")
    .split(",")
    .map((toolName) => toolName.trim())
    .filter(Boolean)
    .map((toolName) => {
      switch (toolName) {
        case "Read":
          return "read";
        case "Write":
          return "write";
        case "Edit":
          return "edit";
        case "Bash":
          return "bash";
        case "Grep":
          return "grep";
        case "Glob":
          return "find";
        default:
          return toolName;
      }
    });
  const base = mapped.length > 0 ? mapped : ["read", "write", "edit", "bash"];
  return [...new Set([...base, ...TEAMROOM_PI_MAIL_TOOL_NAMES])];
}
