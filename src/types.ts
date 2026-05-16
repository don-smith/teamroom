export type MessageDirection = "in" | "out";
export type Provider = "anthropic" | "lm-studio" | "ollama";
export type AgentRuntime = "anthropic" | "langgraph" | "pi";

export interface Agent {
  id: string;
  configPath: string;
  createdAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  channel: string;
  direction: MessageDirection;
  body: string;
  traceId: string;
  createdAt: string;
  // M3 additions — deprecated in M4 (dispatcher no longer writes them),
  // but still present on every read and kept required so existing M3
  // call sites / fixtures keep compiling until the cleanup migration.
  topic: string;                  // routing key within channel; '' for CLI, target-agent for DM
  fromAgentId: string | null;     // null for CLI-originated or outbound
  conversationId: string | null;  // null for pre-M3 rows
  // M4 additions — email-shaped. Optional on a Message literal so pre-M4
  // fixtures continue to compile; the repo's `create` fills defaults
  // ([] for `to`, null for the rest) before inserting. Reads from the DB
  // always populate every field (null when the column is null).
  to?: string[];                  // JSON array in DB; parsed here; [] for legacy CLI rows
  from?: string | null;           // prefixed sender address (agent:*, channel:*, or 'system')
  cc?: string[] | null;           // JSON array in DB; null when unset (distinct from [])
  subject?: string | null;
  threadId?: string | null;       // minted on fresh send; inherited on reply
  readAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
}

/**
 * Input shape for `MessageRepo.create` — M3 fields are optional (filled in
 * with safe defaults by the repo). Lets M4 call sites construct mail rows
 * without the deprecated M3 routing columns.
 */
export type MessageCreateInput =
  & Omit<Message, "topic" | "fromAgentId" | "conversationId">
  & Partial<Pick<Message, "topic" | "fromAgentId" | "conversationId">>;

export interface BusEvent {
  id: string;
  type: string;
  ts: string;
  [k: string]: unknown;
}

export type AuthMode = "api-key" | "oauth";

export interface SpanFields {
  event: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agentId?: string;
  turnId?: string;  // model-proxy trace identifier; distinct from the now-removed DB turns.turn_id
}
