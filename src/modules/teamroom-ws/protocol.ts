export interface RegisterMessage { type: "register"; repoName: string; mailMcpPort: number; mailPort: number; }
export interface OutboundMessage { type: "outbound"; target: string; messageId: string; from: string; to: string[]; body: string; threadId: string; ts: string; }
export interface DaemonEventMessage { type: "event"; event: string; payload: unknown; }
export type RepoToTeamRoom = RegisterMessage | OutboundMessage | DaemonEventMessage;

export interface AckMessage { type: "ack"; repoName: string; adminToken: string; daemonSecret: string; }
export interface DeliverMessage { type: "deliver"; from: string; to: string[]; body: string; threadId: string | null; cc: string[]; }
export type TeamRoomToRepo = AckMessage | DeliverMessage;

export function parseRepoToTeamRoom(raw: string): RepoToTeamRoom {
  const p: Record<string, unknown> = JSON.parse(raw);
  if (!p.type || typeof p.type !== "string") throw new Error("missing or invalid type");
  switch (p.type) {
    case "register":
      if (typeof p.repoName !== "string") throw new Error("register: missing or invalid repoName");
      if (typeof p.mailMcpPort !== "number") throw new Error("register: missing or invalid mailMcpPort");
      if (typeof p.mailPort !== "number") throw new Error("register: missing or invalid mailPort");
      break;
    case "outbound":
      if (typeof p.target !== "string") throw new Error("outbound: missing or invalid target");
      if (typeof p.messageId !== "string") throw new Error("outbound: missing or invalid messageId");
      if (typeof p.from !== "string") throw new Error("outbound: missing or invalid from");
      if (!Array.isArray(p.to)) throw new Error("outbound: missing or invalid to");
      if (typeof p.body !== "string") throw new Error("outbound: missing or invalid body");
      if (typeof p.threadId !== "string") throw new Error("outbound: missing or invalid threadId");
      if (typeof p.ts !== "string") throw new Error("outbound: missing or invalid ts");
      break;
    case "event":
      if (typeof p.event !== "string") throw new Error("event: missing or invalid event");
      break;
  }
  return p as unknown as RepoToTeamRoom;
}

export function parseTeamRoomToRepo(raw: string): TeamRoomToRepo {
  const p: Record<string, unknown> = JSON.parse(raw);
  if (!p.type || typeof p.type !== "string") throw new Error("missing or invalid type");
  switch (p.type) {
    case "ack":
      if (typeof p.repoName !== "string") throw new Error("ack: missing or invalid repoName");
      if (typeof p.adminToken !== "string") throw new Error("ack: missing or invalid adminToken");
      if (typeof p.daemonSecret !== "string") throw new Error("ack: missing or invalid daemonSecret");
      break;
    case "deliver":
      if (typeof p.from !== "string") throw new Error("deliver: missing or invalid from");
      if (!Array.isArray(p.to)) throw new Error("deliver: missing or invalid to");
      if (typeof p.body !== "string") throw new Error("deliver: missing or invalid body");
      break;
  }
  return p as unknown as TeamRoomToRepo;
}