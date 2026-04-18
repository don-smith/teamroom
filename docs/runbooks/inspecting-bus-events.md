# Inspecting bus events

The `FileNotifyBus` in production appends one JSON line per event to `data/bus/events.jsonl`. Subscribers (like `teamroom tail`) poll the file via chokidar. Because the file is append-only and human-readable, you can tail and filter it with standard tools to answer questions like "what did the daemon emit during this turn?" or "did `turn.completed` fire?"

## Preconditions

- A daemon has run (or is running) in this repo, so `data/bus/events.jsonl` exists.
- `jq` installed (`brew install jq` on macOS; `apt install jq` on Debian-family). Not strictly required but unlocks most of the filters below.

## Steps

1. **Live tail:**
   ```bash
   tail -f data/bus/events.jsonl
   ```

2. **Filter by event type:**
   ```bash
   jq -c 'select(.type == "turn.errored")' data/bus/events.jsonl
   jq -c 'select(.type == "message.outbound")' data/bus/events.jsonl
   jq -c 'select(.type | startswith("turn."))' data/bus/events.jsonl
   ```

3. **Filter by trace ID:**
   ```bash
   jq -c 'select(.traceId == "01HKPR...")' data/bus/events.jsonl
   ```
   Or follow a trace across both bus and DB in one invocation:
   ```bash
   TRACE=$(sqlite3 data/teamroom.db "SELECT trace_id FROM messages WHERE direction='in' ORDER BY created_at DESC LIMIT 1")
   jq -c --arg t "$TRACE" 'select(.traceId == $t)' data/bus/events.jsonl
   sqlite3 data/teamroom.db "SELECT id, status, error FROM turns WHERE trace_id = '$TRACE'"
   ```

4. **Count events by type over a run:**
   ```bash
   jq -r '.type' data/bus/events.jsonl | sort | uniq -c
   ```

5. **Pretty-print the most recent N events:**
   ```bash
   tail -n 20 data/bus/events.jsonl | jq .
   ```

6. **Correlate a DB turn to its bus lifecycle:**
   ```bash
   sqlite3 data/teamroom.db "SELECT trace_id FROM turns WHERE id = 'TURN_ID'"
   # → some-uuid
   jq -c --arg t "some-uuid" 'select(.traceId == $t)' data/bus/events.jsonl
   ```

## Verifying success

A single turn produces at least:

- One `turn.started` event at the moment `processTurn` begins.
- One or more `message.outbound` events per `type: "reply"` from the container.
- One terminal event: `turn.completed` (happy path) or `turn.errored` (anything that went wrong).

All three carry the same `traceId`. The outbound `messageId` in a `message.outbound` event matches a `messages.id` row in SQLite with `direction='out'`.

## Troubleshooting

- **`events.jsonl` is missing.** The daemon hasn't started, or its data directory is different. Check `teamroom status` and `ls data/bus/`.
- **`tail -f` shows no new events but the daemon is running.** Either no turn is active (send a message) or the subscriber path is broken — check daemon logs at `data/logs/teamroom-*.jsonl` for errors from `FileNotifyBus`.
- **`jq` prints nothing for a `select(...)` filter.** Your predicate is too strict. Start with `jq -c '.type' data/bus/events.jsonl | head` to see what types actually exist, then narrow.
- **`turn.started` without a matching terminal event.** The daemon crashed or was killed mid-turn. On next boot, reconcile moves orphaned `running` turns to `error='daemon_restart'`. (Known debt: `pending` turns with live containers are missed — see `docs/as-built/2026-04-18-teamroom-m1.md` §5.)
- **File is huge.** It's append-only by design. Rotate or truncate during development (`> data/bus/events.jsonl`); do not do that while the daemon is running — subscribers can miss events across a truncation.

## Related

- `src/bus/README.md` — the `NotifyBus` interface and its two implementations.
- `docs/runbooks/manual-cli-testing.md` — how to generate events to inspect.
- `docs/as-built/2026-04-18-teamroom-m1.md` — §2 event bus.
