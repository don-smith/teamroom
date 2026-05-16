# Manual CLI testing

Exercise the CLI by hand with a real daemon, real Docker, and real LM Studio. Useful for observing a single turn interactively, debugging a specific command without scripted assertions, or demoing the end-to-end flow to another person. If you want automation, use `smoke-test.md` instead.

## Preconditions

- `teamroom` installed on your PATH (`bun scripts/install-cli.ts ~/bin --force`; see README).
- `.env` populated with `LM_STUDIO_API_TOKEN`.
- LM Studio running and the model in `agents/studio-assistant/agent.yaml` loaded.
- Docker Desktop running; `teamroom-agent-studio-assistant:latest` built (`docker build -t teamroom-agent-studio-assistant:latest -f agents/studio-assistant/Dockerfile .`).
- A fresh working directory for state: either start from a clean `data/` (`rm -rf data`) or know what's in it.

## Steps

1. **Terminal A — start the daemon in the foreground.**
   ```bash
   teamroom serve
   ```
   Leave it running. Logs stream to stdout as JSON lines.

2. **Terminal B — send a message.**
   ```bash
   teamroom send studio-assistant "What is the capital of France?"
   ```
   `send` is fire-and-forget: it queues the inbound mail and exits. It does not wait for a reply.

3. **Terminal C — resolve the thread id and inspect the full conversation.**
   ```bash
   THREAD_ID=$(sqlite3 data/teamroom.db "SELECT thread_id FROM messages WHERE agent_id='studio-assistant' AND direction='in' ORDER BY created_at DESC LIMIT 1")
   teamroom thread "$THREAD_ID"
   ```
   Re-run `teamroom thread "$THREAD_ID"` until the outbound reply row appears. The daemon in Terminal A picks up the inbound row, spawns a container, and the reply typically lands within a few seconds (latency is mostly the LLM call). If you want a live reply surface instead of polling a thread, use `teamroom chat studio-assistant`.

4. **Inspect state with the DB directly.**
   ```bash
   sqlite3 data/teamroom.db
   sqlite> .tables
   sqlite> SELECT id, channel, direction, substr(body, 1, 50), thread_id FROM messages ORDER BY created_at;
   ```

5. **Correlate the message to the daemon log by trace ID.**
   ```bash
   sqlite3 data/teamroom.db "SELECT trace_id FROM messages WHERE direction='in' ORDER BY created_at DESC LIMIT 1"
   # → some-uuid
   grep '"traceId":"some-uuid"' data/logs/teamroom-*.jsonl
   ```

6. **Check daemon status.**
   ```bash
   teamroom status
   ```
   Reports the daemon PID/liveness and the current mail/chat/mail-MCP port bindings.

7. **Stop the daemon.** `Ctrl+C` in Terminal A. The daemon handles SIGINT/SIGTERM and shuts down cleanly. (Known debt: PID file may not be unlinked on clean shutdown — see `docs/as-built/2026-04-18-teamroom-m1.md` §5.)

## Verifying success

- Your sent message appears as a `direction='in'` row in `messages`.
- One or more `direction='out'` rows appear with the same `thread_id`.
- `teamroom thread "$THREAD_ID"` shows both the inbound prompt and the outbound reply.
- `data/logs/teamroom-*.jsonl` contains a `model.call.completed` record for the same `trace_id`.

## Troubleshooting

- **`teamroom: command not found`.** The install dir isn't on your PATH or you haven't run `bun scripts/install-cli.ts ~/bin --force`. Verify with `which teamroom` and `echo $PATH`.
- **`teamroom send` exits with `chat port file not found — is the daemon running?`** `send` refuses to start when the daemon's chat port file is missing. Start the daemon first.
- **`teamroom thread "$THREAD_ID"` shows only your sent row.** The reply hasn't landed yet, or the container errored. Re-run the command after a short delay, then inspect `data/logs/teamroom-*.jsonl` for the inbound row's `trace_id`.
- **Container errors with `connect ECONNREFUSED`.** The agent-runtime inside the container tries to reach `host.docker.internal:1234`. LM Studio must be running and bound such that the host is reachable from the container.
- **Data looks stale.** Multiple turns accrete in `data/teamroom.db` across runs. If you want a clean slate: stop the daemon, `rm -rf data`, restart.

## Related

- `docs/runbooks/inspecting-bus-events.md` — how the daemon log mirrors the current in-process bus notifications.
- `docs/runbooks/smoke-test.md` — scripted version of the same flow.
- `docs/as-built/2026-04-18-teamroom-m1.md` — §2 turn lifecycle and CLI surface.
