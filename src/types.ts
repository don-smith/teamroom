export type MessageDirection = "in" | "out";
export type TurnStatus = "pending" | "running" | "done" | "error";
export type Provider = "anthropic" | "lm-studio";

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
  turnId: string | null;
  traceId: string;
  createdAt: string;
  // M3 additions — deprecated in M4; retained in the schema until a later
  // cleanup migration. Optional here so new M4 call sites don't have to
  // set them; the repo's `create` fills defaults ('', null, null).
  topic?: string;                 // routing key within channel; '' for CLI, target-agent for DM
  fromAgentId?: string | null;    // null for CLI-originated or outbound
  conversationId?: string | null; // null for pre-M3 rows
  // M4 additions — email-shaped. Optional at the type level so pre-M4
  // fixtures that construct a Message literal continue to compile; the
  // repo's `create` fills defaults ([] for `to`, null for the rest). Reads
  // from the DB always populate every field (null when the column is null).
  to?: string[];                  // JSON array in DB; parsed here; [] for legacy CLI rows
  from?: string | null;           // prefixed sender address (agent:*, cli:*, or 'system')
  cc?: string[] | null;           // JSON array in DB; null when unset (distinct from [])
  subject?: string | null;
  threadId?: string | null;       // minted on fresh send; inherited on reply
  readAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
}

export interface Turn {
  id: string;
  agentId: string;
  inboundMessageId: string;
  status: TurnStatus;
  containerId: string | null;
  error: string | null;
  traceId: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  conversationId: string | null;  // M3 addition; null for pre-M3 rows
}

export interface BusEvent {
  id: string;
  type: string;
  ts: string;
  [k: string]: unknown;
}

export interface MessageOutboundEvent extends BusEvent {
  type: "message.outbound";
  agentId: string;
  messageId: string;
  turnId: string;
  traceId: string;
}

export interface TurnLifecycleEvent extends BusEvent {
  type: "turn.started" | "turn.completed" | "turn.errored";
  agentId: string;
  turnId: string;
  traceId: string;
  error?: string;
}

export type AuthMode = "api-key" | "oauth";

export interface SpanFields {
  event: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  agentId?: string;
  turnId?: string;
}
