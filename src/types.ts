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
