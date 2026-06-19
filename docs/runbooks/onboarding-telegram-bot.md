# Onboarding: Connect a Telegram Bot to a Team Room Agent

## Overview

Each Team Room agent can be paired with its own Telegram bot. When you DM the bot, messages route to the agent via the mail dispatcher, and the agent's replies come back to your Telegram chat. Voice messages are transcribed via OpenAI Whisper; agent replies can include TTS audio.

## Prerequisites

- A running Team Room daemon (or are about to start one)
- A Telegram account and the Telegram app (mobile or desktop)
- BotFather (@BotFather) open in Telegram — search for it and start a chat

## Step 1 — Choose which agents need bots

Existing agents:

| Agent | Runtime | Type |
|---|---|---|
| `doc` | Pi | Coding agent |
| `libby` | Pi | Coding agent |
| `archie` | DeepAgents | Long-running persistent agent |
| `micah` | Pi | Coding agent |

Start with one bot per agent you want to reach via Telegram.

## Step 2 — Prepare a password manager entry

Before creating bots, open your password manager and create a new entry with this template:

```
Team Room — Telegram Bot Tokens
================================

Bot doc (Pi, doctor/qa eng):
  Username: _doc_bot
  Token: 

Bot archie (DeepAgents, architect):
  Username: _archie_bot
  Token: 

Bot hisa (DeepAgents, historian):
  Username: _hisa_bot
  Token: 

Bot dev (Pi, developer):
  Username: _dev_bot
  Token: 
```

You will fill in the tokens as you create each bot with BotFather in the next step. Having them in your password manager means you can reference them later for .env setup, re-creation, or sharing with a teammate — without relying on memory or Telegram's message history.

## Step 3 — Create Telegram bots with BotFather

1. In Telegram, open **BotFather** and send `/newbot`
2. Follow the prompts:
   - **Name:** Something descriptive, e.g. `Doc` or `Archie`
   - **Username:** must end in `bot`, e.g. `teamroom_doc_bot` (must be globally unique)
3. BotFather replies with a **token** like `123456:ABCdefGHIjklmNOpqrsTUVwxyz`
4. **Copy the token** into your password manager entry immediately — it won't be shown again
5. Repeat for each agent you want to pair with a bot

## Step 4 — Add tokens to environment variables

Add each token to your `.env` file (at repo root):

```env
TELEGRAM_TOKEN_DOC=123456:ABCdefGHIjklmNOpqrsTUVwxyz
TELEGRAM_TOKEN_ARCHIE=789012:GHIjklmNOpqrsTUVwxyzABCDef
```

**Convention:** `TELEGRAM_TOKEN_<AGENT_NAME_UPPERCASE>` matches the `tokenEnvVar` field in `telegram.yaml`.

For voice features, ensure your OpenAI key is also set:

```env
TEAMROOM_OPENAI_API_KEY=sk-...
```

## Step 5 — Configure telegram.yaml

Edit `telegram.yaml` at the repo root. Add an entry for each bot to agent pair:

```yaml
bots:
  - agent: doc
    tokenEnvVar: TELEGRAM_TOKEN_DOC
  - agent: archie
    tokenEnvVar: TELEGRAM_TOKEN_ARCHIE
```

Each entry pairs an agent name (matching the agent's `agent.yaml` `name` field) with the env var holding the Telegram bot token.

## Step 6 — Start the daemon

```bash
npm run cli:serve
```

Check the startup logs for:

```
telegram gateway started     botCount: 2
telegram.bot_started         agent: doc     username: teamroom_doc_bot
telegram.bot_started         agent: archie  username: teamroom_archie_bot
```

If the daemon crashes at start, your token may be invalid. Check the token in .env and re-create the bot if needed.

## Step 7 — Send a text message

1. Open Telegram, find your bot (search by username)
2. Start a chat and send any text message, e.g. `hello`
3. Within a few seconds, the agent should reply

If no reply comes:
- Check the daemon logs for `telegram.inbound.text` and `telegram.inbound.dispatch_error`
- Check that the agent has an active session. For persistent agents (DeepAgents) look for `session.persistent_boot_spawn`. For session agents look for `session started`.
- Send a message via the CLI to verify the agent is responsive: `echo "hello" | teamroom send agent:<agentName>`

## Step 8 — Send a voice message (optional)

1. In Telegram, tap the microphone icon next to the message input
2. Record and send a voice message
3. The bot should reply with the transcribed text from Whisper
4. Once the text reply arrives, a voice audio message follows momentarily (fire-and-forget TTS). **All** replies on voice-originated threads get TTS, no minimum length threshold.

If voice fails:
- Check `TEAMROOM_OPENAI_API_KEY` is set correctly
- Check logs for `telegram.inbound.stt_error` or `telegram.outbound.tts_failed`
- The user receives the fallback "Voice processing is unavailable" message

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Daemon crashes at start | Invalid bot token | Re-create bot with BotFather, update .env |
| "telegram gateway skipped" in logs | telegram.yaml not found or empty | Create file at repo root with at least one bot entry |
| No reply from bot | Agent not running or dispatcher error | Check daemon logs; try `teamroom send` to verify agent |
| Voice always says "unavailable" | `TEAMROOM_OPENAI_API_KEY` not set | Add key to .env and restart daemon |
| TTS audio never arrives | Thread not voice-originated or text <200 chars | Voice TTS only fires on threads started by a voice message |
| Bot not found in Telegram | Bot username wasn't saved after creation | Re-create with BotFather, choose a unique username |

## Removing a bot

1. In BotFather, send `/removebot`, select the bot
2. Remove its entry from `telegram.yaml`
3. Remove its token from `.env`
4. Restart the daemon
