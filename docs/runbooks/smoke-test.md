# Smoke test

End-to-end verification that the full stack — daemon, in-process model proxy, CLI, real Docker, real LM Studio, and the real Anthropic API — talks to itself correctly. Runs `scripts/smoke-test.sh`. Use this before shipping a change that touches the container contract, the daemon orchestrator, the model proxy, the CLI, or any build step. Do not use for normal unit-test iteration — that is `bun test` (see `running-tests.md`).

## Preconditions

- **LM Studio running** on `localhost:1234` with a model loaded. Default expected model: `qwen/qwen3.5-9b` (match whatever is in `agents/studio-assistant/agent.yaml`).
- **Docker Desktop running.** The smoke test builds two agent images and runs containers that reach back to the host via `host.docker.internal`.
- **`.env` file** at repo root containing `LM_STUDIO_API_TOKEN=<value>` matching your LM Studio instance.
- **Anthropic credentials discoverable.** Either `CLAUDE_CODE_OAUTH_TOKEN=<token>` or `ANTHROPIC_API_KEY=<key>` in `.env`, OR `~/.claude/.credentials.json` from a prior `claude` login. See `docs/runbooks/anthropic-auth.md` for discovery order.
- **Bun 1.3+ installed**; `bun install` has run.
- **Branch in the state you want to test.** The smoke test deletes `data/` at startup.

## Steps

1. From the repo root:
   ```bash
   ./scripts/smoke-test.sh
   ```

2. The script will:
   - Confirm LM Studio is reachable.
   - Confirm Anthropic credentials are present.
   - Run `bun run typecheck`.
   - Build both agent images (`teamroom-agent-studio-assistant:latest`, `teamroom-agent-claude-assistant:latest`).
   - Wipe `data/`, start the daemon via `bun src/cli/main.ts serve` (which boots the in-process `LocalModelProxy`), wait for `data/teamroom.pid`.
   - For each agent in turn: send a message asking for an exact marker reply, resolve the new inbound row's `thread_id` from `data/teamroom.db`, then poll `bun src/cli/main.ts thread <threadId>` for up to 60 s until an outbound row contains the marker.
   - Grep the daemon's JSONL log for `model.call.completed` spans from both providers (`anthropic` and `lm-studio`).
   - Report `SMOKE PASS` and shut down the daemon.

## Verifying success

- Final line prints `==> SMOKE PASS — both agents responded; both providers' spans present`.
- Each smoke-tested thread contains the inbound prompt row plus an outbound reply row whose body contains the expected marker.
- `data/logs/teamroom-YYYY-MM-DD.jsonl` contains at least one record with `"event":"model.call.completed"` and `"provider":"anthropic"`, and at least one with `"provider":"lm-studio"`.
- In OAuth mode, you should also see one `"event":"oauth.exchange.completed"` per temp-key TTL window (typically once per smoke-test run).
- The daemon exits cleanly (no zombie `bun src/cli/main.ts serve` process).
- `data/teamroom.db` has at least one inbound message row per smoke-tested agent and at least one outbound reply row in each smoke-tested thread.

## Interpreting the log

The daemon writes span-shaped JSONL records. Useful greps:

```bash
LOG=$(ls -1t data/logs/teamroom-*.jsonl | head -1)
# All proxy spans for this run:
grep '"event":"model\.' "$LOG" | jq .
# Just the anthropic calls:
grep '"event":"model.call.completed"' "$LOG" | grep '"provider":"anthropic"' | jq .
# OAuth exchange roundtrips (OAuth mode only, on cache miss):
grep '"event":"oauth.exchange.completed"' "$LOG" | jq .
# Reconstruct a full turn by traceId:
grep '"traceId":"<the trace id>"' "$LOG" | jq .
```

## Troubleshooting

- **`LM Studio not reachable at http://localhost:1234`.** LM Studio isn't running, or is bound to a different host. Set `LM_STUDIO_HOST_URL=http://...` and re-run, or start LM Studio and load a model.
- **`Anthropic credentials not found`.** Add `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` to `.env`, or run `claude` once locally so `~/.claude/.credentials.json` exists. See `docs/runbooks/anthropic-auth.md`.
- **`.env file required (with LM_STUDIO_API_TOKEN)`.** Copy `.env.example` to `.env` and fill in the token.
- **`no available models` in the daemon log.** LM Studio is running but no model is loaded. Load the model referenced in `agents/studio-assistant/agent.yaml`.
- **401 / auth error from LM Studio.** `LM_STUDIO_API_TOKEN` in `.env` does not match LM Studio's expected token.
- **401 from Anthropic on first call.** OAuth-token expired, or the OAuth-exchange endpoint rejected the token. Check `oauth.exchange.completed` span; if absent, the proxy never reached the exchange. If present and the next `model.call.completed` is 401, the token's actually invalid — re-login with `claude` or paste a fresh `CLAUDE_CODE_OAUTH_TOKEN`.
- **`Cannot connect to the Docker daemon`.** Docker Desktop is not running.
- **Container cannot reach the host.** On macOS/Windows `host.docker.internal` is supplied by Docker Desktop. On Linux you may need `--add-host=host.docker.internal:host-gateway`. The smoke test currently assumes Docker Desktop.
- **`daemon failed to start`.** Check `data/logs/teamroom-*.jsonl` and stderr for the daemon's last few lines; usually a port/file-permission issue.
- **Timeout waiting for `studio-ok` / `claude-ok`.** The model replied but not with the expected literal, or never replied. The script already dumps the agent inbox, the full smoke-test thread (once resolved), the last 40 daemon log lines, and recent `teamroom-*` containers on failure. If the model paraphrased, the smoke test's exact-match assertion is too strict for that model; switch models or adjust the prompt. If there's no reply at all, inspect the daemon log and the thread contents together.
- **No `"provider":"anthropic"` span in the log.** The Anthropic agent never reached the proxy — usually because credentials were missing at boot (the daemon will log `agent.unhealthy` once on startup) or the agent's `agent.yaml` model id is wrong.

## Related

- `docs/runbooks/running-tests.md` — fast in-memory suite; different purpose.
- `docs/runbooks/manual-cli-testing.md` — run the pieces by hand instead of scripted.
- `docs/runbooks/anthropic-auth.md` — credential discovery + OAuth mode details.
- `docs/specs/2026-04-18-m2-model-abstraction-design.md` — §4 data flow, §6 auth modes, §8 observability.
