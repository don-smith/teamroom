# Smoke test

End-to-end verification that the full stack — daemon, in-process model proxy, CLI, real Docker, and OpenRouter — talks to itself correctly. Use this before shipping a change that touches the container contract, the daemon orchestrator, the model proxy, the CLI, or any build step. Do not use for normal unit-test iteration — that is `bun test` (see `running-tests.md`).

> **Note:** The old `scripts/smoke-test.sh` script references removed agents (`studio-assistant`, `claude-assistant`) and has not yet been updated for the consolidated roster. Manual smoke testing is recommended until the script is rewritten.

## Preconditions

- **Docker Desktop running.** The test builds agent images and runs containers that reach back to the host via `host.docker.internal`.
- **`.env` file** at repo root containing `OPENROUTER_API_KEY=<key>`.
- **Bun 1.3+ installed**; `bun install` has run.
- **Agent images built** for the agents under test (e.g. `teamroom-agent-micah:latest`, `teamroom-agent-archie:latest`).
- **Branch in the state you want to test.** Data is transient.

## Manual smoke test steps

1. **Start the daemon.**
   ```bash
   rm -rf data
   bun src/cli/main.ts serve
   ```

2. **In a second terminal, send messages to each agent.**
   ```bash
   bun src/cli/main.ts send micah "Reply with the word 'micah-ok' exactly"
   bun src/cli/main.ts send archie "Reply with the word 'archie-ok' exactly"
   ```

3. **Resolve thread IDs and verify replies.**
   ```bash
   for agent in micah archie; do
     echo "=== $agent ==="
     THREAD_ID=$(sqlite3 data/teamroom.db \
       "SELECT thread_id FROM messages WHERE agent_id='$agent' AND direction='in' ORDER BY created_at DESC LIMIT 1")
     bun src/cli/main.ts thread "$THREAD_ID"
   done
   ```
   Poll until each thread shows an outbound row containing the expected marker.

4. **Verify proxy spans in the daemon log.**
   ```bash
   LOG=$(ls -1t data/logs/teamroom-*.jsonl | head -1)
   grep '"event":"model.call.completed"' "$LOG" | jq .
   ```

5. **Stop the daemon** with `Ctrl+C`.

## Interpreting the log

Useful greps:

```bash
LOG=$(ls -1t data/logs/teamroom-*.jsonl | head -1)
# All proxy spans:
grep '"event":"model\.' "$LOG" | jq .
# Just the OpenRouter calls:
grep '"event":"model.call.completed"' "$LOG" | grep '"provider":"openrouter"' | jq .
# Reconstruct a full turn by traceId:
grep '"traceId":"<the trace id>"' "$LOG" | jq .
```

## Troubleshooting

- **`.env file required (with OPENROUTER_API_KEY)`.** Copy `.env.example` to `.env` and fill in the key.
- **401 from OpenRouter.** `OPENROUTER_API_KEY` in `.env` is invalid or expired. Generate a new key at [openrouter.ai/keys](https://openrouter.ai/keys).
- **`Cannot connect to the Docker daemon`.** Docker Desktop is not running.
- **Container cannot reach the host.** On macOS/Windows `host.docker.internal` is supplied by Docker Desktop. On Linux you may need `--add-host=host.docker.internal:host-gateway`.
- **`daemon failed to start`.** Check `data/logs/teamroom-*.jsonl` and stderr for the daemon's last few lines; usually a port/permission issue or missing `OPENROUTER_API_KEY`.
- **Timeout waiting for a marker word.** The model replied but not with the expected literal, or never replied. Check the daemon log and agent inbox together.
- **No `"provider":"openrouter"` span in the log.** The agent never reached the proxy — usually because the daemon can't reach OpenRouter's API.
- **Agent container immediately exits.** Rebuild the agent image and verify Dockerfile dependencies are correct.

## Related

- `docs/runbooks/running-tests.md` — fast in-memory suite; different purpose.
- `docs/runbooks/manual-cli-testing.md` — run the pieces by hand instead of scripted.
- `docs/runbooks/anthropic-auth.md` — credential setup (superseded; now just OpenRouter).
- `docs/specs/2026-04-18-m2-model-abstraction-design.md` — §4 data flow, §6 auth modes, §8 observability.
