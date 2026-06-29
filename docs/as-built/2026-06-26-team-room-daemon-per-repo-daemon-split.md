# Team Room Daemon + Per-Repo Daemon Split

## Quick Reference
- **Date:** 2026-06-26
- **Key files:** `src/daemon/teamroom-daemon.ts`, `src/daemon/repo-daemon.ts`, `src/modules/teamroom-ws/{protocol,teamroom-ws,repo-ws,teamroom-chat}.ts`, `src/daemon/repo-config.ts`, `src/model-proxy/token-registry.ts`
- **Key concepts:** Team Room daemon, per-repo-daemon, cross-process-websocket, hmac-tokens, auto-spawn, delivery-error-relay, admin-token-isolation
- **One-line summary:** Split the monolithic daemon into a Team Room daemon (model proxy, chat WS, Telegram, daemon supervision) and per-repo daemons (containers, mail DB, mail-MCP) connected by a typed WebSocket protocol with HMAC-signed model proxy tokens and per-daemon admin token isolation.

## How It Works Now

### Process topology

```
Team Room daemon (one instance, always running)
├── Model proxy (HTTP, shared by all per-repo daemons)
├── Chat WebSocket (WS, CLI users connect here)
├── Telegram gateway (composed, activated when telegram.yaml present)
│   Listens on channel.out for telegram-scoped replies
├── Per-repo daemon WS listener
│   Maintains routeTable: Map<repoName, DaemonConnection>
│   Registers daemons on connect, tears down on close
│   Sends ack with per-connection adminToken + shared daemonSecret
│   Republishes daemon channel.out events onto Team Room daemon event bus
│   Republishes delivery_error events as delivery.error bus events
└── Auto-spawn: spawns per-repo daemon on first delivery if not connected

Per-repo daemon (one per repo, started by Team Room daemon auto-spawn or manually)
├── Observability, Storage, Messaging (in-process event bus)
├── McpMail (dispatcher, MCP tools, mailing lists)
├── Session management (Docker container lifecycle)
├── Mail MCP server (HTTP, for agent containers + Team Room daemon delivery)
├── Mail query WS (inbox, thread — CLI connects directly)
└── Connects to Team Room daemon WS on startup, sends register message
```

### Data layout

```
~/.teamroom/
├── repos.yaml              # Team Room daemon: repo index
│   repos:
│     <name>:
│       codebasePath: /path/to/repo
│       agents?: { <agent>: { model?: string } }   # per-repo overrides
├── repos/
│   └── <name>/
│       ├── data/
│       │   ├── teamroom.db
│       │   ├── ports/{mail-mcp,mail,repo-daemon}.port
│       │   └── logs/
│       └── stores/{archie,doc,libby,micah}/
└── agents/
    └── {archie,doc,libby,micah}/
        ├── agent.yaml       # shared definition (lifecycle overridden to session)
        ├── AGENTS.md
        ├── Dockerfile
        └── shim.py
```

### WebSocket protocol (`src/modules/teamroom-ws/protocol.ts`)

The per-repo daemon connects TO the Team Room daemon on startup. The protocol is typed:

**Repo daemon → Team Room daemon:**
| Message | Fields | Purpose |
|---|---|---|
| `register` | `repoName`, `mailMcpPort`, `mailPort` | Register in route table |
| `outbound` | `target`, `messageId`, `from`, `to[]`, `body`, `threadId` | Forward agent reply to CLI/Telegram |
| `event` | `event: string`, `payload` | Arbitrary daemon events (e.g. `delivery_error`) |

**Team Room daemon → repo daemon:**
| Message | Fields | Purpose |
|---|---|---|
| `ack` | `repoName`, `adminToken`, `daemonSecret` | Confirm registration, hand out credentials |
| `deliver` | `from`, `to[]`, `body`, `threadId`, `cc[]` | Deliver inbound mail to the per-repo daemon |

The `ack.adminToken` is unique per daemon registration (not shared). The `ack.daemonSecret` is shared across all daemons and used for HMAC-signing model proxy tokens.

### Cross-process model proxy tokens (`src/model-proxy/token-registry.ts`)

In the single-process architecture, the token registry was an in-memory Map. Now repo daemons mint tokens the Team Room daemon proxy must verify:

- **Local mint**: in-process Map lookup (used by Team Room daemon itself)
- **Remote mint**: `signEntry(entry, sharedSecret)` → `tr.{base64url(json(entry))}.{base64url(hmac)}` — used by per-repo daemons
- **Lookup**: tries local Map first, falls back to `verifyRemoteToken()` which validates the HMAC and extracts the embedded `TokenEntry`

The `daemonSecret` is sent to each daemon in the `ack` message after registration. If `daemonSecret` is unavailable, `remoteMint()` throws loudly instead of silently minting invalid tokens (fixed from Q2 review finding).

### Delivery failure relay chain

When `dispatcher.sendMail()` throws in the per-repo daemon's `deliver` handler:

1. `repo-ws.ts` catches the error, logs `repo-ws.delivery_failed`, and sends `{ type: "event", event: "delivery_error", payload: { repoName, target, from, to, threadId, error } }` to Team Room daemon (if WS is open)
2. `teamroom-ws.ts` receives the `event` message, filters for `delivery_error`, and publishes `delivery.error` on the Team Room daemon event bus
3. `teamroom-chat.ts` subscribes to `delivery.error`, extracts the CLI user from `target`/`from` (`channel:cli:<user>`), finds the matching CLI connection, and sends `{ type: "error", code: "delivery_failed", message }` to the user

### Admin token isolation

Each per-repo daemon receives a distinct `adminToken` generated at registration time (not a shared singleton). The admin token authenticates Team Room daemon MCP calls to the per-repo daemon. If one daemon is compromised, its admin token cannot be used to impersonate admin on other repos.

The admin token comparison in `mail-mcp/server.ts` uses `crypto.timingSafeEqual` to avoid timing side-channels.

### Auto-spawn

`teamroom-daemon.ts:ensureDaemon()` spawns a per-repo daemon on first message delivery. If the spawned child fails to connect within 15s, the child is killed with SIGTERM before re-throwing (fixes Q1 orphaned child bug).

### CLI changes

- `teamroom serve` now defaults to Team Room daemon. `--repo <name>` starts a per-repo daemon.
- `teamroom repo init <path>` registers a repo; `repo list` shows registered repos; `repo remove <name>` unregisters.
- When `TEAMROOM_REPO` is set, `chat`/`send` route through the Team Room daemon chat WS instead of connecting directly to a local daemon. `inbox`/`thread` still connect to the per-repo daemon's mail query WS directly via port files.

### Agent lifecycle override

All agents in the per-repo daemon run as `lifecycle: session` regardless of what `agent.yaml` declares. The override happens in `repo-daemon.ts:discoverRepoAgentConfigs()` — persistent agents are a Team Room daemon concern for this architecture.

## Key Decisions

### WebSocket direction: daemon connects TO Team Room daemon

**What:** The per-repo daemon opens a WebSocket client to the Team Room daemon listener on startup, rather than the Team Room daemon connecting to each daemon.

**Why:** The Team Room daemon starts first and has a well-known listener. Reverse connections avoid port file discovery for the Team Room daemon WS port and let the daemon reconnect on disconnect.

**Regression risk:** low — this is the standard client-server pattern and the reconnect logic is simple (5s timeout retry).

### Model proxy stays in Team Room daemon

**What:** The model proxy is composed only in the Team Room daemon, not in per-repo daemons. Daemons mint tokens through HMAC-signed `remoteMint()`.

**Why:** A single proxy instance enforces a single OpenRouter API key and avoids port conflicts. The HMAC signing pattern bridges the process boundary without exposing the in-memory token map.

**Regression risk:** medium — a future change might be tempted to move the proxy to per-repo daemons for lower latency. That would require per-daemon API keys and eliminate token sharing.

**Rejected alternative:** Give each per-repo daemon its own model proxy. Rejected because it requires per-daemon API key management, creates port conflicts, and loses centralized token visibility.

### Mail query WS stays in per-repo daemon

**What:** The read-only mail query WebSocket (inbox, thread) stays in the per-repo daemon. The CLI reads the daemon's mail port file directly.

**Why:** Moving it to the Team Room daemon would require a proxying layer for every read-only SQLite query. Not justified until remote query scenarios arise.

**Regression risk:** low.

### Delivery uses existing WS, not MCP HTTP

**What:** The Team Room daemon delivers inbound mail to per-repo daemons via the WebSocket `deliver` message, not via MCP HTTP POST.

**Why:** The protocol already had `DeliverMessage`, and `repo-ws.ts` already handled `deliver` by calling `dispatcher.sendMail()`. MCP HTTP hit 406 errors due to Streamable HTTP `Accept` header requirements and was conceptually redundant.

**Regression risk:** low.

### repos.yaml atomic writes

**What:** `saveReposYaml()` writes to `repos.yaml.tmp` then `renameSync()`s to `repos.yaml`, preventing partial writes if two processes write concurrently.

**Why:** `writeFileSync` truncates the file on open. Two concurrent writes produce a corrupt/truncated file.

**Regression risk:** low.

## Constraints & Gotchas

- **Per-repo daemon must connect before deliveries work.** Team Room daemon auto-spawns the daemon and waits 15s for connection. If the daemon fails to register, deliveries will fail with "no daemon connected."
- **daemonSecret must be available before remoteMint.** Token minting throws if the shared secret hasn't arrived via `ack`. The WS protocol ensures ack is sent before any `deliver` message, so the window is theoretically closed — but the code fails loudly rather than silently minting invalid tokens.
- **Agent definitions are shared; stores are per-repo.** `~/.teamroom/agents/<name>/agent.yaml` is the single source of truth for agent configuration. Per-repo stores live at `~/.teamroom/repos/<name>/stores/<agent>/`. `buildSpec` overrides the store mount path via `storeBasePath`.
- **All agents run as `lifecycle: session` in per-repo daemons.** The daemon overrides `lifecycle` to `session` at load time. Persistent lifecycle is not supported in the per-repo architecture.
- **Telegram gateway wiring is now implemented.** Cross-process Telegram routing flows inbound from Telegram through the Team Room daemon to the target repo daemon, and outbound from the repo daemon over the Team Room daemon bus to the Telegram gateway.
- **`channel.out` body propagation.** The `mail-dispatcher` now includes `body` in `channel.out` events so the reply content reaches CLI/Telegram clients through the Team Room daemon relay.
- **Orphaned daemon cleanup.** `ensureDaemon` kills the spawned child with SIGTERM if `waitForConnection` times out, preventing process leaks.

## Background Context

Team Room was a single-process daemon that composed nine modules: observability, storage, messaging, MCP mail, Telegram, model proxy, session management, channels, and mail query — all sharing one in-process event bus and one SQLite database. This worked for a single repo but couldn't scale to multiple repos.

The Team Room daemon/per-repo daemon split makes Team Room multi-repo by design: a single Team Room daemon gateways all external communication (CLI, Telegram, model proxy) while per-repo daemons own per-repo state (containers, mail DB, agent stores). The split also isolates failure domains — a crashed repo daemon doesn't affect other repos' operations.

The implementation follows a 5-phase plan inherited from `.myflow/artifacts/plans/2026-06-19_Team Room daemon-per-repo-daemon.md`. A code review (`.myflow/artifacts/reviews/2026-06-22_phase5-chat-routing-auto-spawn.md`) found 12 findings; 8 were resolved in implementation and 4 suggestions were tabled. Manual verification confirmed end-to-end multi-turn chat through the Team Room daemon route.