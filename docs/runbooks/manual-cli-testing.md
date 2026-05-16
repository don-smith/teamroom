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

3. **Terminal C — inspect the agent's inbox.**
   ```bash
   teamroom inbox studio-assistant
   ```
   Re-run `teamroom inbox studio-assistant` until the reply appears. The daemon in Terminal A picks up the inbound row, spawns a container, and the reply typically lands within a few seconds (latency is mostly the LLM call).

4. **Inspect state with the DB directly.**
   ```bash
   sqlite3 data/teamroom.db
   sqlite> .tables
   sqlite> SELECT id, channel, direction, substr(body, 1, 50), thread_id FROM messages ORDER BY created_at;
   ```

5. **Correlate events by trace ID.** Every message carries a `trace_id`; every turn carries the same `trace_id`; every bus event carries it too.
   ```bash
   sqlite3 data/teamroom.db "SELECT trace_id FROM messages WHERE direction='in' ORDER BY created_at DESC LIMIT 1"
   # → some-uuid
   grep '"traceId":"some-uuid"' data/bus/events.jsonl
   grep '"traceId":"some-uuid"' data/logs/teamroom-*.jsonl
   ```

6. **Check daemon status.**
   ```bash
   teamroom status
   ```
   Reports PID/alive and per-status turn counts.

7. **Stop the daemon.** `Ctrl+C` in Terminal A. The daemon handles SIGINT/SIGTERM and shuts down cleanly. (Known debt: PID file may not be unlinked on clean shutdown — see `docs/as-built/2026-04-18-teamroom-m1.md` §5.)

## Verifying success

- Your sent message appears as a `direction='in'` row in `messages`.
- One or more `direction='out'` rows appear with the same `thread_id`.
- `teamroom inbox studio-assistant` shows the reply.
- `data/bus/events.jsonl` contains `turn.started` and `turn.completed` events for that trace.

## Troubleshooting

- **`teamroom: command not found`.** The install dir isn't on your PATH or you haven't run `bun scripts/install-cli.ts ~/bin --force`. Verify with `which teamroom` and `echo $PATH`.
- **`teamroom send` warns "daemon not detected."** `send` queues the inbound row regardless, but without the daemon it will sit pending. Start the daemon.
- **`teamroom inbox studio-assistant` prints nothing yet.** Messages land after the turn completes. Either the turn is still running (check `teamroom status`) or the container errored (check `data/bus/events.jsonl` for `turn.errored`).
- **Container errors with `connect ECONNREFUSED`.** The agent-runtime inside the container tries to reach `host.docker.internal:1234`. LM Studio must be running and bound such that the host is reachable from the container.
- **Data looks stale.** Multiple turns accrete in `data/teamroom.db` across runs. If you want a clean slate: stop the daemon, `rm -rf data`, restart.

## Related

- `docs/runbooks/inspecting-bus-events.md` — deeper view of `events.jsonl`.
- `docs/runbooks/smoke-test.md` — scripted version of the same flow.
- `docs/as-built/2026-04-18-teamroom-m1.md` — §2 turn lifecycle and CLI surface.
