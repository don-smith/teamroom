import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
}

export function loadConversation(path: string): ConversationMessage[] {
  if (!existsSync(path)) return [];
  const contents = readFileSync(path, "utf8");
  const out: ConversationMessage[] = [];
  for (const line of contents.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as ConversationMessage;
      if ((parsed.role === "user" || parsed.role === "assistant") && typeof parsed.content === "string") {
        out.push(parsed);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

export function appendMessage(path: string, message: ConversationMessage): void {
  appendFileSync(path, JSON.stringify(message) + "\n");
}
