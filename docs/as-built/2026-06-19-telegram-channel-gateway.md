# Telegram Channel Gateway — Multi-Bot DM Gateway

## Quick Reference
- **Date:** 2026-06-29
- **Key files:** `src/gateways/telegram-config.ts`, `src/gateways/telegram-gateway.ts`, `src/daemon/teamroom-daemon.ts`, `src/modules/teamroom-ws/{repo-ws,teamroom-ws}.ts`, `src/mail-dispatcher/mail-dispatcher.ts`, `telegram.yaml`
- **Key concepts:** channel.out event, grammy long-polling, Whisper STT, fire-and-forget TTS, Team Room daemon, repo routing
- **One-line summary:** Each agent gets its own Telegram bot for direct-message interaction; the Team Room daemon owns Telegram and routes inbound/outbound messages across per-repo daemon WebSockets.

## How It Works Now

### Event Architecture
The `channel.cli.out` event has been generalized to `channel.out`. The mail dispatcher now publishes a `channel.out` event for every message delivered to a `channel:*` recipient, with a `channel` field in the payload (e.g. `channel: "cli"` or `channel: "telegram"`) and the message `body`. Subscribers filter by channel name:

- **TeamRoomChat** (`src/modules/teamroom-ws/teamroom-chat.ts`): subscribes to the Team Room daemon bus, filters to `channel === "cli"`, and delivers to registered CLI WebSocket clients.
- **TelegramGateway** (`src/gateways/telegram-gateway.ts`): subscribes to the Team Room daemon bus, filters to `channel === "telegram"`, and delivers to Telegram chats via grammy.

Per-repo daemons relay all local `channel.out` events to the Team Room daemon over WS as `target: channel:<channel>:<user>`. The Team Room daemon parses the target back into `channel` and `user` before republishing on its bus.

### Address Format
Channel addresses use the 4-part format `channel:<channelName>:<botName>:<chatId>`, e.g. `channel:telegram:doc:12345`. The existing address parser at `src/mail-dispatcher/address.ts` already handles this — `externalId` captures everything after the channel name (i.e. `<botName>:<chatId>`).

### Telegram Gateway
The gateway lives in `src/gateways/` and follows the existing `compose*` factory pattern:

**`telegram-config.ts`** — YAML config loader following the `lists.yaml` pattern. Reads `telegram.yaml`, validates each bot entry requires `agent` (agent name), `tokenEnvVar` (env var holding the Telegram bot token), and `repo` (registered repo target). Throws if any env var is unset/empty or any required field is missing.

**`telegram-gateway.ts`** — `TelegramGateway` class managing one grammy `Bot` instance per configured agent:

- **Inbound text**: `bot.on("message:text")` → `deliverInbound()` from `channel:telegram:<agent>:<chatId>` to `agent:<agent>`. In the Team Room daemon, `deliverInbound` resolves the bot's configured repo and sends a WS `deliver` message to that repo daemon.
- **Inbound voice**: `bot.on("message:voice")` → downloads from Telegram → OpenAI Whisper STT → `deliverInbound()`. Thread is tracked as voice-originated in an in-memory `Set<string>`. Falls back to `"Voice processing is unavailable, please send text."` on any failure.
- **Outbound text**: Subscribes to `channel.out` filtered to `channel === "telegram"`. Parses `user` field as `<botName>:<chatId>`. Sends with Markdown parse mode, falling back to plain text on parse error. Splits messages >4096 chars.
- **Outbound voice** (fire-and-forget): For voice-originated threads, after text is sent, fires `ttsSendVoice()` in the background. OpenAI TTS (tts-1, alloy) → `bot.api.sendVoice()`. Never blocks text delivery. Minimum 200-char threshold.
- **IPv4 forced**: `https.Agent({ family: 4 })` in grammy's `baseFetchConfig` — Nanoclaw lesson for Tailscale/WireGuard compatibility.
- **Lifecycle**: `start()` creates all bot instances and subscribes to the bus. `stop()` unsubscribes and stops all bots.

### Channel Registry
`ChannelRegistry` now registers both `"cli"` and `"telegram"` at daemon startup (`src/modules/channels/channels.ts`). The `telegram` channel is used by the gateway for address validation.

### Team Room Daemon Wiring
The production Telegram gateway is started by `startTeamRoomDaemon()`:

1. `teamroom serve` loads `~/.teamroom/.env` and passes `~/.teamroom/telegram.yaml` explicitly.
2. `startTeamRoomDaemon()` fails loudly before runtime ports are written if the file is missing, invalid, references an unknown repo, or if bot initialization fails.
3. The gateway is composed after Team Room WS and `ensureDaemon()` exist, so inbound Telegram can resolve agent → repo and deliver to the correct per-repo daemon.
4. OpenAI client creation remains lazy; if `TEAMROOM_OPENAI_API_KEY` is absent, voice features are disabled with a startup warning.
5. Shutdown stops the Telegram gateway with the other Team Room daemon ingress surfaces.

The legacy monolithic `startDaemon()` still supports optional Telegram wiring for older/local compositions, but the Team Room daemon runtime path treats Telegram as required.

## Key Decisions

### Generic channel.out event over per-channel events
- **What:** Single `channel.out` event with `channel` field rather than separate events per channel
- **Why:** Avoids event-name proliferation; each new channel just needs a subscriber with a filter
- **Regression risk:** medium — a future developer might propose per-channel events for "type safety." The current approach is simple and matches the existing pattern; a type union on the payload is sufficient.
- **Rejected alternative:** `channel.cli.out`, `channel.telegram.out`, etc.
- **Why rejected:** Would require a new event name per channel and duplicated subscription logic.

### Grammy over raw fetch() polling
- **What:** Use `grammy` library for Telegram Bot API integration
- **Why:** Eliminates ~80 lines of polling boilerplate, offset persistence, and reconnection logic
- **Regression risk:** low — grammy is a mature, well-maintained library
- **Rejected alternative:** Raw `getUpdates` with offset persistence in the agent's `store/` directory
- **Why rejected:** More code surface, more things to go wrong, offset persistence adds complexity. Grammy's chat-server lessons (leaked subscribers) show value of library-managed lifecycle.

### Fire-and-forget TTS
- **What:** Text reply sent immediately; TTS audio synthesized and sent in background
- **Why:** User never waits for voice processing to read the reply; TTS failure never blocks communication
- **Regression risk:** low

### Gateway stays in the Team Room daemon
- **What:** Gateway runs inside the Team Room daemon process, not inside per-repo daemons and not as a separate service
- **Why:** Single deployment for external ingress, no extra process manager, one Telegram long-polling owner, and a stable place to route to many repo daemons
- **Regression risk:** medium — future multi-repo work may be tempted to move Telegram into repo daemons. Keep it centralized so each bot has one long-polling owner.

### Address format: channel:telegram:<botName>:<chatId>
- **What:** 4-part address with both bot name and chat ID
- **Why:** Multi-bot scenario — same human DMing bot_doc and bot_libby → same chatId "12345" for both; bot name disambiguates
- **Regression risk:** low — parser already handles this format

### IPv4 forced for Telegram connections
- **What:** `family: 4` on grammy's HTTP agent
- **Why:** Happy Eyeballs on Tailscale/WireGuard hangs on IPv6 attempt before failing over
- **Regression risk:** low — confirmed by Nanoclaw production experience

## Constraints & Gotchas

- **Runtime Telegram config is required for the Team Room daemon**: `~/.teamroom/telegram.yaml` must exist, every bot must include `agent`, `tokenEnvVar`, and `repo`, token env vars must be set, and each `repo` must exist in `repos.yaml`. Missing/invalid config fails startup before runtime port files are written.
- **Grammy token validation**: Grammy throws at `bot.start()` if the token is invalid. `TelegramGateway.start()` logs the failing bot, stops any initialized bot instances, and rejects startup. This is intentional: don't run with broken Telegram connectivity.
- **OpenAI key is optional**: `TEAMROOM_OPENAI_API_KEY` is read at daemon startup. If absent, voice features are disabled with a startup warning. The `openai` dep is left `undefined` and voice handlers gracefully reply with "Voice processing is unavailable."
- **Voice thread tracking is in-memory only**: `voiceThreadIds` is a `Set<string>` that resets on daemon restart. Voice-originated threads lose TTS after restart. Acceptable for single-operator use.
- **Single human operator assumed**: No multi-user patterns are implemented. The grammy long-polling model supports one bot per agent for one operator.
- **No media beyond voice**: Photos, videos, documents, stickers are silently ignored.
- **TTS minimum length**: Only fires for responses ≥200 characters. Shorter responses are text-only.
- **channel.out bus logging**: The daemon registers a `channel.out` bus observability subscriber for all channels. When the Telegram gateway is inactive (no `telegram.yaml`), this subscriber still fires but has no downstream effect.

## Background Context

Built for the Telegram Channel milestone and updated during the Team Room daemon/per-repo daemon split follow-up. The goal was to let humans DM any Team Room agent without routing syntax while preserving multi-repo isolation. Each agent gets its own Telegram bot (configured in `~/.teamroom/telegram.yaml`), and the gateway runs inside the Team Room daemon as a first-class compose module. Voice was included from the start to match the NanoClaw reference implementation, using OpenAI Whisper for STT and TTS with a fire-and-forget pattern so text is never delayed by voice processing.