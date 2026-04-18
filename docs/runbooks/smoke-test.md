# Smoke test

End-to-end verification that the full stack — daemon, CLI, real Docker, real LM Studio — talks to itself correctly. Runs `scripts/smoke-test.sh`. Use this before shipping a change that touches the container contract, the daemon orchestrator, the CLI, or any build step. Do not use for normal unit-test iteration — that is `npm test` (see `running-tests.md`).

## Preconditions

- **LM Studio running** on `localhost:1234` with a model loaded. Default expected model: `qwen/qwen3.5-9b` (match whatever is in `agents/assistant/agent.yaml`).
- **Docker Desktop running.** The smoke test builds the agent image and runs a container that reaches back to the host via `host.docker.internal`.
- **`.env` file** at repo root containing `LM_STUDIO_API_TOKEN=<value>` matching your LM Studio instance.
- **Node.js 20+**; `npm install` has run.
- **Branch in the state you want to test.** The smoke test deletes `data/` at startup.

## Steps

1. From the repo root:
   ```bash
   ./scripts/smoke-test.sh
   ```

2. The script will:
   - Confirm LM Studio is reachable.
   - Run `npm run build`.
   - Build the agent image (`teamroom-agent-assistant:latest`).
   - Wipe `data/`, start the daemon, wait for `data/teamroom.pid`.
   - Start `teamroom tail` redirected to `/tmp/teamroom-smoke-output.txt`.
   - Send `"Hello from the smoke test — reply with exactly: hello back"`.
   - Poll for `hello back` in the tail output for up to 60 seconds.
   - Report `SMOKE PASS` and shut down the daemon.

## Verifying success

- Final line prints `==> SMOKE PASS`.
- `/tmp/teamroom-smoke-output.txt` contains a line matching `hello back`.
- The daemon exits cleanly (no zombie process in `ps | grep dist/cli/main.js`).
- `data/teamroom.db` has one agent, one inbound message, one outbound message, one `done` turn.

## Troubleshooting

- **`LM Studio not reachable at http://localhost:1234`.** LM Studio isn't running, or is bound to a different host. Set `LM_STUDIO_HOST_URL=http://...` and re-run, or start LM Studio and load a model.
- **`.env file required (with LM_STUDIO_API_TOKEN)`.** Copy `.env.example` to `.env` and fill in the token.
- **`no available models` in tail output.** LM Studio is running but no model is loaded. Load the model referenced in `agents/assistant/agent.yaml`.
- **401 / auth error.** `LM_STUDIO_API_TOKEN` in `.env` does not match LM Studio's expected token. Check LM Studio's server settings.
- **`Cannot connect to the Docker daemon`.** Docker Desktop is not running.
- **Container cannot reach the host.** On macOS/Windows `host.docker.internal` is supplied by Docker Desktop. On Linux you may need `--add-host=host.docker.internal:host-gateway`. The smoke test currently assumes Docker Desktop.
- **`daemon failed to start`.** Check `data/logs/teamroom-*.jsonl` and stderr for the daemon's last few lines; usually a port/file-permission issue.
- **Timeout waiting for `hello back`.** The model replied but not with the expected literal. Look at the tail output — if the model gave a paraphrase, the smoke test's exact-match assertion is too strict for that model; switch models or adjust the prompt. If there's no reply at all, inspect `data/bus/events.jsonl` for `turn.errored`.

## Related

- `docs/runbooks/running-tests.md` — fast in-memory suite; different purpose.
- `docs/runbooks/manual-cli-testing.md` — run the pieces by hand instead of scripted.
- `docs/as-built/2026-04-18-teamroom-m1.md` — §2 turn lifecycle and container contract.
