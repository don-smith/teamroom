import { existsSync, readFileSync } from "node:fs";
import { appendMessage, loadConversation, type ConversationMessage } from "./session-store.js";

export interface Envelope {
  prompt: string;
  messageId: string;
  turnId: string;
  traceId: string;
}

export interface LlmCreateArgs {
  model: string;
  system: string;
  messages: ConversationMessage[];
}

export interface LlmCreateResult {
  text: string;
}

export interface LlmClient {
  createMessage(args: LlmCreateArgs): Promise<LlmCreateResult>;
}

export interface RunTurnDeps {
  envelope: Envelope;
  client: LlmClient;
  model: string;
  agentsMdPath: string;
  conversationPath: string;
  emit: (jsonLine: string) => void;
}

const DEFAULT_SYSTEM_PROMPT =
  "You are an agent running inside the Team Room harness. Respond to the user's message directly and concisely.";

export async function runTurn(deps: RunTurnDeps): Promise<void> {
  const system = existsSync(deps.agentsMdPath)
    ? readFileSync(deps.agentsMdPath, "utf8")
    : DEFAULT_SYSTEM_PROMPT;

  const prior = loadConversation(deps.conversationPath);
  const userMessage: ConversationMessage = { role: "user", content: deps.envelope.prompt };
  const messages = [...prior, userMessage];

  appendMessage(deps.conversationPath, userMessage);

  const result = await deps.client.createMessage({
    model: deps.model,
    system,
    messages,
  });

  const assistantMessage: ConversationMessage = { role: "assistant", content: result.text };
  appendMessage(deps.conversationPath, assistantMessage);

  deps.emit(
    JSON.stringify({
      type: "reply",
      body: result.text,
      messageId: deps.envelope.messageId,
    }),
  );
}
