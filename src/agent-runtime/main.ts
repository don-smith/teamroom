import OpenAI from "openai";
import { AnthropicLlmClient } from "./anthropic-llm-client.js";
import { runTurn, type LlmClient, type Envelope } from "./runtime.js";

const AGENTS_MD = "/AGENTS.md";
const CONVERSATION_PATH = "/store/conversation.jsonl";

async function readStdinOnce(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function makeOpenAiCompatibleClient(): LlmClient {
  const baseURL = process.env.TEAMROOM_MODEL_BASE_URL;
  if (!baseURL) throw new Error("TEAMROOM_MODEL_BASE_URL is required");
  const apiKey = process.env.TEAMROOM_MODEL_API_TOKEN ?? "not-required";
  // The OpenAI SDK appends `/chat/completions` to baseURL — it does NOT add
  // `/v1`. OpenAI-compatible servers (LM Studio, etc.) expect requests at
  // `/v1/chat/completions`, so the `/v1` prefix has to be in baseURL itself.
  // (This matches OpenAI's own published baseURL: `https://api.openai.com/v1`.)
  // The Anthropic SDK has the opposite convention — it adds `/v1/messages`
  // automatically — so we only adjust here, not in the proxy or daemon.
  const baseURLWithV1 = baseURL.replace(/\/$/, "") + "/v1";
  const sdk = new OpenAI({ baseURL: baseURLWithV1, apiKey });
  return {
    async createMessage({ model, system, messages }) {
      const resp = await sdk.chat.completions.create({
        model,
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
        max_tokens: 1024,
      });
      const text = resp.choices[0]?.message?.content ?? "";
      return { text };
    },
  };
}

function buildLlmClient(): LlmClient {
  const provider = process.env.TEAMROOM_PROVIDER;
  if (provider === "anthropic") {
    // AnthropicLlmClient reads ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN
    // from process.env directly (so the spawned Claude Code CLI subprocess
    // sees them). The daemon's turn-processor injects both env vars at
    // container-spawn time. No constructor wiring needed here.
    if (!process.env.ANTHROPIC_BASE_URL) throw new Error("ANTHROPIC_BASE_URL is required");
    if (!process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_AUTH_TOKEN is required");
    return new AnthropicLlmClient();
  }
  if (provider === "lm-studio") {
    return makeOpenAiCompatibleClient();
  }
  throw new Error(`unknown TEAMROOM_PROVIDER: ${String(provider)}`);
}

async function main(): Promise<void> {
  try {
    const raw = await readStdinOnce();
    const envelope = JSON.parse(raw.trim()) as Envelope;
    const model = process.env.TEAMROOM_MODEL;
    if (!model) throw new Error("TEAMROOM_MODEL is required");
    const client = buildLlmClient();
    await runTurn({
      envelope,
      client,
      model,
      agentsMdPath: AGENTS_MD,
      conversationPath: CONVERSATION_PATH,
      emit: (line) => process.stdout.write(line + "\n"),
    });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`agent-runtime fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) process.stderr.write(err.stack + "\n");
    process.exit(2);
  }
}

void main();
