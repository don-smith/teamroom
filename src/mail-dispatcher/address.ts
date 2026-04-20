/**
 * M4 addresses are prefixed strings — `<kind>:<name>`. Three kinds today:
 *   agent:<name>  — an agent's inbox.
 *   cli:<user>    — the CLI channel (no inbox; tail renders it).
 *   list:<name>   — a mailing list. Resolved by the dispatcher at send time.
 *
 * `system` (mailing-list fanout from the harness) goes through the `from`
 * field verbatim; it isn't a valid recipient prefix.
 */

export type Address =
  | { kind: "agent"; name: string }
  | { kind: "cli"; user: string }
  | { kind: "list"; name: string };

const VALID_PREFIXES = new Set(["agent", "cli", "list"]);

export function parseAddress(s: string): Address {
  const idx = s.indexOf(":");
  if (idx <= 0 || idx === s.length - 1) throw new Error(`invalid address: ${s}`);
  const prefix = s.slice(0, idx);
  const rest = s.slice(idx + 1);
  if (!VALID_PREFIXES.has(prefix)) throw new Error(`unknown address prefix: ${prefix}`);
  if (prefix === "agent") return { kind: "agent", name: rest };
  if (prefix === "cli") return { kind: "cli", user: rest };
  return { kind: "list", name: rest };
}

export function formatAddress(a: Address): string {
  switch (a.kind) {
    case "agent": return `agent:${a.name}`;
    case "cli": return `cli:${a.user}`;
    case "list": return `list:${a.name}`;
  }
}
