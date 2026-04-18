import OpenAI from "openai";
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
  const sdk = new OpenAI({ baseURL, apiKey });
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

async function main(): Promise<void> {
  try {
    const raw = await readStdinOnce();
    const envelope = JSON.parse(raw.trim()) as Envelope;
    const model = process.env.TEAMROOM_MODEL;
    if (!model) throw new Error("TEAMROOM_MODEL is required");
    const client = makeOpenAiCompatibleClient();
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
