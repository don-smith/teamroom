# Manual CLI testing

Exercise the CLI interactively with a real daemon, real Docker, and a live OpenRouter-backed agent. Useful for observing a single turn, debugging a specific command, or demoing the end-to-end flow.

## Preconditions

- `teamroom` installed on your PATH (`bun scripts/install-cli.ts ~/bin --force`; see README).
- `.env` populated with `OPENROUTER_API_KEY`.
- Docker Desktop running; agent images built:
  ```bash
  docker build -t teamroom-agent-micah:latest -f agents/micah/Dockerfile .
  docker build -t teamroom-agent-archie:latest -f agents/archie/Dockerfile .
  ```
- A fresh working directory for state: either start from a clean `data/` (`rm -rf data`) or know what's in it.

## Steps

1. **Terminal A — start the daemon in the foreground.**
   ```bash
   bun src/cli/main.ts serve
   ```
   Leave it running. Logs stream to stdout as JSON lines.

2. **Terminal B — send a message to an agent (e.g., Micah).**
   ```bash
   bun src/cli/main.ts send micah "What is the capital of France?"
   ```
   `send` is fire-and-forget: it queues the inbound mail and exits. It does not wait for a reply.

3. **Terminal C — resolve the thread id and inspect the full conversation.**
   ```bash
   THREAD_ID=$(sqlite3 data/teamroom.db "SELECT thread_id FROM messages WHERE agent_id='micah' AND direction='in' ORDER BY created_at DESC LIMIT 1")
   bun src/cli/main.ts thread "$THREAD_ID"
   ```
   Re-run until the outbound reply row appears. The daemon picks up the inbound row, spawns a container, and the reply typically lands within a few seconds.

4. **Or use `chat` for a live interactive session.**
   ```bash
   bun src/cli/main.ts chat micah
   ```
   Messages appear live as the agent replies.

5. **Inspect state with the DB directly.**
   ```bash
   sqlite3 data/teamroom.db
   sqlite> .tables
   sqlite> SELECT id, channel, direction, substr(body, 1, 50), thread_id FROM messages ORDER BY created_at;
   ```

6. **Correlate the message to the daemon log by trace ID.**
   ```bash
   sqlite3 data/teamroom.db "SELECT trace_id FROM messages WHERE direction='in' ORDER BY created_at DESC LIMIT 1"
   # → some-uuid
   grep '"traceId":"some-uuid"' data/logs/teamroom-*.jsonl
   ```

7. **Check daemon status.**
   ```bash
   bun src/cli/main.ts status
   ```
   Reports the daemon PID/liveness and current port bindings.

8. **Stop the daemon.** `Ctrl+C` in Terminal A.

## Verifying success

- Your sent message appears as a `direction='in'` row in `messages`.
- One or more `direction='out'` rows appear with the same `thread_id`.
- `bun src/cli/main.ts thread "$THREAD_ID"` shows both the inbound prompt and the outbound reply.
- `data/logs/teamroom-*.jsonl` contains a `model.call.completed` record for the same `trace_id`.

## Troubleshooting

- **`teamroom: command not found`.** The install dir isn't on your PATH or you haven't run `bun scripts/install-cli.ts ~/bin --force`. Verify with `which teamroom` and `echo $PATH`.
- **Daemon exits immediately.** Check `.env` has `OPENROUTER_API_KEY` set.
- **`teamroom send` exits with `chat port file not found — is the daemon running?`** Start the daemon first.
- **Thread shows only your sent row.** The reply hasn't landed yet, or the container errored. Re-run after a delay, then inspect `data/logs/teamroom-*.jsonl` for the inbound row's `trace_id`.
- **Container errors with `connect ECONNREFUSED`.** The proxy port is unreachable from inside Docker. Check the daemon log for proxy bootstrap errors.
- **Data looks stale.** Stop the daemon, `rm -rf data`, restart.

## Related

- `docs/runbooks/inspecting-bus-events.md` — how the daemon log mirrors the current in-process bus notifications.
- `docs/runbooks/smoke-test.md` — scripted version of the same flow.
- `docs/runbooks/smoke-test.md` — scripted version of the same flow.
