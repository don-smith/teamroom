/**
 * M4.5 addresses are hierarchical:
 *   agent:<name>                       — an agent's inbox
 *   list:<name>                        — a mailing list (resolved at dispatch)
 *   channel:<channel>:<external-id>    — a channel-routed external recipient
 *
 * Lenient parse / strict deliver: any well-formed address parses; the
 * dispatcher rejects channel addresses whose `channel` isn't in the
 * channel registry at delivery time.
 */

export type Address =
  | { kind: "agent"; name: string }
  | { kind: "list"; name: string }
  | { kind: "channel"; channel: string; externalId: string };

const TOP_LEVEL_PREFIXES = new Set(["agent", "list", "channel"]);

export function parseAddress(s: string): Address {
  const idx = s.indexOf(":");
  if (idx <= 0 || idx === s.length - 1) throw new Error(`invalid address: ${s}`);
  const prefix = s.slice(0, idx);
  const rest = s.slice(idx + 1);
  if (!TOP_LEVEL_PREFIXES.has(prefix)) {
    throw new Error(`unknown address prefix: ${prefix}`);
  }
  if (prefix === "agent") return { kind: "agent", name: rest };
  if (prefix === "list") return { kind: "list", name: rest };
  // channel:<channel>:<external-id>
  const colonIdx = rest.indexOf(":");
  if (colonIdx <= 0 || colonIdx === rest.length - 1) {
    throw new Error(`invalid channel address: ${s}`);
  }
  return {
    kind: "channel",
    channel: rest.slice(0, colonIdx),
    externalId: rest.slice(colonIdx + 1),
  };
}

export function formatAddress(a: Address): string {
  switch (a.kind) {
    case "agent": return `agent:${a.name}`;
    case "list": return `list:${a.name}`;
    case "channel": return `channel:${a.channel}:${a.externalId}`;
  }
}
