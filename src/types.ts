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
  // M3 additions:
  topic: string;                  // routing key within channel; '' for CLI, target-agent for DM
  fromAgentId: string | null;     // null for CLI-originated or outbound
  conversationId: string | null;  // null for pre-M3 rows
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
