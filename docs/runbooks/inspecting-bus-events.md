# Inspecting bus events

The current bus is the in-process `EventBus` described in [`src/bus/README.md`](../../src/bus/README.md). It is not durable and it does not write a separate `data/bus/events.jsonl` file. The operator-visible surface is the daemon JSONL log in `data/logs/`: `startDaemon()` mirrors the key bus notifications (`mail.delivered`, `mail.sent`, `tool.call`) into that log, and the model proxy writes span-shaped entries there as well (`model.call.completed`, `model.call.rejected`, `oauth.exchange.completed`).

## Preconditions

- A daemon has run (or is running) in this repo, so `data/logs/teamroom-YYYY-MM-DD.jsonl` exists.
- `jq` installed (`brew install jq` on macOS; `apt install jq` on Debian-family). Not strictly required but unlocks most of the filters below.

## Steps

1. **Locate the newest daemon log:**
   ```bash
   LOG=$(ls -1t data/logs/teamroom-*.jsonl | head -1)
   ```

2. **Live tail:**
   ```bash
   tail -f "$LOG"
   ```

3. **Filter mirrored bus notifications by log message:**
   ```bash
   jq -c 'select(.msg == "mail.delivered")' "$LOG"
   jq -c 'select(.msg == "mail.sent")' "$LOG"
   jq -c 'select(.msg == "tool.call")' "$LOG"
   ```

4. **Filter model-proxy spans:**
   ```bash
   jq -c 'select(.event == "model.call.completed")' "$LOG"
   jq -c 'select(.event == "model.call.rejected")' "$LOG"
   jq -c 'select(.event == "oauth.exchange.completed")' "$LOG"
   ```

5. **Filter by trace ID:**
   ```bash
   jq -c 'select(.traceId == "01HKPR...")' "$LOG"
   ```
   Or follow a trace across the DB and the daemon log in one invocation:
   ```bash
   LOG=$(ls -1t data/logs/teamroom-*.jsonl | head -1)
   TRACE=$(sqlite3 data/teamroom.db "SELECT trace_id FROM messages WHERE direction='in' ORDER BY created_at DESC LIMIT 1")
   jq -c --arg t "$TRACE" 'select(.traceId == $t)' "$LOG"
   ```

6. **Count entries by event/message name over a run:**
   ```bash
   jq -r '.event // .msg' "$LOG" | sort | uniq -c
   ```

7. **Pretty-print the most recent N entries:**
   ```bash
   tail -n 20 "$LOG" | jq .
   ```

8. **Check the full thread alongside the daemon log:**
   ```bash
   THREAD_ID=$(sqlite3 data/teamroom.db "SELECT thread_id FROM messages WHERE direction='in' ORDER BY created_at DESC LIMIT 1")
   teamroom thread "$THREAD_ID"
   ```

## Verifying success

A typical CLI-to-agent exchange produces at least:

- One `mail.delivered` log entry when the inbound message lands in the agent's inbox.
- One or more `tool.call` log entries if the agent uses the mail MCP tools.
- One `model.call.completed` span when the proxy finishes the upstream call.
- Often one `mail.sent` log entry if the agent sends a mail reply to another agent.

Not every bus notification carries a `traceId`. For end-to-end correlation, start from the inbound message row's `trace_id` in SQLite, then grep the daemon log for that `traceId`. For the actual reply body, use `teamroom thread <threadId>` or `teamroom chat`; the internal `channel.cli.out` notification is not mirrored into the log.

## Troubleshooting

- **No log file under `data/logs/`.** The daemon has not started, or it died before observability booted. Check `teamroom status` and start the daemon in the foreground to see startup errors.
- **`jq` prints nothing for a `select(...)` filter.** Your predicate is too strict. Start with `jq -c '.event // .msg' "$LOG" | head` to see what the current run actually emitted, then narrow.
- **You need the actual reply body, not just lifecycle signals.** Use `teamroom thread <threadId>` or `teamroom chat`; the daemon log shows control-flow and proxy spans, not the CLI-delivered reply envelope.
- **The log is huge.** It is append-only by design. Rotate or remove old `data/logs/teamroom-*.jsonl` files between runs if you want a clean view.

## Related

- `src/bus/README.md` — current in-process `EventBus` contract.
- `docs/runbooks/manual-cli-testing.md` — how to generate live mail/thread traffic to inspect.
- `docs/as-built/2026-04-22-teamroom-m4.5.md` — the M4.5 removal of `FileNotifyBus`, `teamroom tail`, and the legacy turn subsystem.
