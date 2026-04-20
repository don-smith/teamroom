import { createInterface } from "node:readline";
import OpenAI from "openai";
import { AnthropicLlmClient } from "./anthropic-llm-client.js";
import { processWake, type LlmClient, type WakeEnvelope } from "./runtime.js";

const AGENTS_MD = "/AGENTS.md";

function makeOpenAiCompatibleClient(): LlmClient {
  const baseURL = process.env.TEAMROOM_MODEL_BASE_URL;
  if (!baseURL) throw new Error("TEAMROOM_MODEL_BASE_URL is required");
  const apiKey = process.env.TEAMROOM_MODEL_API_TOKEN ?? "not-required";
  // OpenAI SDK expects /v1 in the baseURL (see M2 notes). Anthropic SDK
  // adds /v1/messages itself, so we only adjust for OpenAI-compat here.
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
    if (!process.env.ANTHROPIC_BASE_URL) throw new Error("ANTHROPIC_BASE_URL is required");
    if (!process.env.ANTHROPIC_AUTH_TOKEN) throw new Error("ANTHROPIC_AUTH_TOKEN is required");
    const toolsRaw = process.env.TEAMROOM_ALLOWED_TOOLS ?? "";
    const allowedTools = toolsRaw.trim() === ""
      ? []
      : toolsRaw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
    // M4: if the daemon injected a mail-MCP endpoint + per-spawn token,
    // register the mail server on the claude-agent-sdk session so tool
    // calls inside the LLM turn can reach the dispatcher.
    const mcpUrl = process.env.TEAMROOM_MCP_URL;
    const mcpToken = process.env.TEAMROOM_MCP_TOKEN;
    const mcpServers = mcpUrl && mcpToken
      ? {
          mail: {
            type: "http" as const,
            url: mcpUrl,
            headers: { "x-teamroom-mcp-token": mcpToken },
          },
        }
      : undefined;
    return new AnthropicLlmClient({ allowedTools, mcpServers });
  }
  if (provider === "lm-studio") {
    return makeOpenAiCompatibleClient();
  }
  throw new Error(`unknown TEAMROOM_PROVIDER: ${String(provider)}`);
}

async function main(): Promise<void> {
  const model = process.env.TEAMROOM_MODEL;
  if (!model) throw new Error("TEAMROOM_MODEL is required");
  const client = buildLlmClient();

  // Wake loop. Each stdin line is a `{type:"wake", events: [...]}` envelope.
  // EOF (daemon closed stdin) ends the session.
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let envelope: WakeEnvelope;
    try {
      envelope = JSON.parse(trimmed) as WakeEnvelope;
    } catch (err) {
      process.stderr.write(`agent-runtime: invalid wake envelope: ${String(err)}\n`);
      continue;
    }
    try {
      await processWake({
        wake: envelope,
        client,
        model,
        agentsMdPath: AGENTS_MD,
        onText: (text) => process.stderr.write(`[llm] ${text}\n`),
      });
    } catch (err) {
      process.stderr.write(
        `agent-runtime: processWake failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
    }
  }
}

void main().catch((err) => {
  process.stderr.write(`agent-runtime fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
