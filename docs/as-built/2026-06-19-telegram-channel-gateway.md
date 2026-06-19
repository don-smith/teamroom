# Telegram Channel Gateway — Multi-Bot DM Gateway

## Quick Reference
- **Date:** 2026-06-19
- **Key files:** `src/gateways/telegram-config.ts`, `src/gateways/telegram-gateway.ts`, `src/mail-dispatcher/mail-dispatcher.ts`, `src/modules/channels/chat-server.ts`, `src/modules/channels/channels.ts`, `src/daemon/daemon.ts`, `telegram.yaml`
- **Key concepts:** channel.out event, grammy long-polling, Whisper STT, fire-and-forget TTS, ChannelRegistry
- **One-line summary:** Each agent gets its own Telegram bot for direct-message interaction, with voice message transcription and text-to-speech, running in-process inside the daemon.

## How It Works Now

### Event Architecture
The `channel.cli.out` event has been generalized to `channel.out`. The mail dispatcher now publishes a `channel.out` event for every message delivered to a `channel:*` recipient, with a `channel` field in the payload (e.g. `channel: "cli"` or `channel: "telegram"`). Subscribers filter by channel name:

- **ChatServer** (`src/modules/channels/chat-server.ts`): subscribes to `channel.out`, filters to `channel === "cli"`, delivers to registered WebSocket clients.
- **TelegramGateway** (`src/gateways/telegram-gateway.ts`): subscribes to `channel.out`, filters to `channel === "telegram"`, delivers to Telegram chats via grammy.

### Address Format
Channel addresses use the 4-part format `channel:<channelName>:<botName>:<chatId>`, e.g. `channel:telegram:doc:12345`. The existing address parser at `src/mail-dispatcher/address.ts` already handles this — `externalId` captures everything after the channel name (i.e. `<botName>:<chatId>`).

### Telegram Gateway
The gateway lives in `src/gateways/` and follows the existing `compose*` factory pattern:

**`telegram-config.ts`** — YAML config loader following the `lists.yaml` pattern. Reads `telegram.yaml`, validates each bot entry requires `agent` (agent name) and `tokenEnvVar` (env var holding the Telegram bot token). Throws if any env var is unset or empty. 11 unit tests.

**`telegram-gateway.ts`** — `TelegramGateway` class managing one grammy `Bot` instance per configured agent:

- **Inbound text**: `bot.on("message:text")` → `dispatcher.sendMail()` from `channel:telegram:<agent>:<chatId>` to `agent:<agent>`.
- **Inbound voice**: `bot.on("message:voice")` → downloads from Telegram → OpenAI Whisper STT → `dispatcher.sendMail()`. Thread is tracked as voice-originated in an in-memory `Set<string>`. Falls back to `"Voice processing is unavailable, please send text."` on any failure.
- **Outbound text**: Subscribes to `channel.out` filtered to `channel === "telegram"`. Parses `user` field as `<botName>:<chatId>`. Sends with Markdown parse mode, falling back to plain text on parse error. Splits messages >4096 chars.
- **Outbound voice** (fire-and-forget): For voice-originated threads, after text is sent, fires `ttsSendVoice()` in the background. OpenAI TTS (tts-1, alloy) → `bot.api.sendVoice()`. Never blocks text delivery. Minimum 200-char threshold.
- **IPv4 forced**: `https.Agent({ family: 4 })` in grammy's `baseFetchConfig` — Nanoclaw lesson for Tailscale/WireGuard compatibility.
- **Lifecycle**: `start()` creates all bot instances and subscribes to the bus. `stop()` unsubscribes and stops all bots.

### Channel Registry
`ChannelRegistry` now registers both `"cli"` and `"telegram"` at daemon startup (`src/modules/channels/channels.ts`). The `telegram` channel is used by the gateway for address validation.

### Daemon Wiring (Section 6)
The Telegram gateway is conditionally started in a new Section 6 of `startDaemon()`, between messaging (5) and codebase-mount resolution (7):

1. Checks for `telegram.yaml` at `<agentsDir>/../telegram.yaml` (or `opts.telegramYamlPath`)
2. If absent: logs `"telegram gateway skipped"` — no crash
3. If present: loads config, creates OpenAI client lazily (voice disabled if `TEAMROOM_OPENAI_API_KEY` unset), calls `composeTelegram()`, starts gateway
4. Shuts down ingress-first alongside ChatServer on stop

Bus observability logging for `channel.out` events is registered alongside existing `mail.delivered`, `mail.sent`, `tool.call` subscribers.

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

### In-process gateway (no separate service)
- **What:** Gateway runs inside the daemon process
- **Why:** Single deployment, no process management, shares event bus in-memory
- **Regression risk:** low — follows Team Room's principle of minimizing long-running process dependencies

### Address format: channel:telegram:<botName>:<chatId>
- **What:** 4-part address with both bot name and chat ID
- **Why:** Multi-bot scenario — same human DMing bot_doc and bot_libby → same chatId "12345" for both; bot name disambiguates
- **Regression risk:** low — parser already handles this format

### IPv4 forced for Telegram connections
- **What:** `family: 4` on grammy's HTTP agent
- **Why:** Happy Eyeballs on Tailscale/WireGuard hangs on IPv6 attempt before failing over
- **Regression risk:** low — confirmed by Nanoclaw production experience

## Constraints & Gotchas

- **Grammy token validation**: Grammy throws at `bot.start()` if the token is invalid. The daemon does not catch this — a misconfigured token will crash the daemon. This is intentional: don't run with broken Telegram connectivity.
- **OpenAI key is optional**: `TEAMROOM_OPENAI_API_KEY` is read at daemon startup. If absent, voice features are disabled with a startup warning. The `openai` dep is left `undefined` and voice handlers gracefully reply with "Voice processing is unavailable."
- **Voice thread tracking is in-memory only**: `voiceThreadIds` is a `Set<string>` that resets on daemon restart. Voice-originated threads lose TTS after restart. Acceptable for single-operator use.
- **Single human operator assumed**: No multi-user patterns are implemented. The grammy long-polling model supports one bot per agent for one operator.
- **No media beyond voice**: Photos, videos, documents, stickers are silently ignored.
- **TTS minimum length**: Only fires for responses ≥200 characters. Shorter responses are text-only.
- **channel.out bus logging**: The daemon registers a `channel.out` bus observability subscriber for all channels. When the Telegram gateway is inactive (no `telegram.yaml`), this subscriber still fires but has no downstream effect.

## Background Context

Built for the Telegram Channel milestone. The goal was to let humans DM any Team Room agent without startup ceremony or routing syntax. Each agent gets its own Telegram bot (configured in `telegram.yaml`), and the gateway runs inside the daemon as a first-class compose module. Voice was included from the start to match the NanoClaw reference implementation, using OpenAI Whisper for STT and TTS with a fire-and-forget pattern so text is never delayed by voice processing.