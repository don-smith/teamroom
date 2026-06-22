# Smoke test

End-to-end verification that the full stack — daemon, in-process model proxy, CLI, real Docker, and OpenRouter — talks to itself correctly. Use this before shipping a change that touches the container contract, the daemon orchestrator, the model proxy, the CLI, or any build step. Do not use for normal unit-test iteration — that is `bun test` (see `running-tests.md`).

> **Note:** The old `scripts/smoke-test.sh` script references removed agents (`studio-assistant`, `claude-assistant`) and has not yet been updated for the consolidated roster. Manual smoke testing is recommended until the script is rewritten.

## Preconditions

- **Docker Desktop running.** The test builds agent images and runs containers that reach back to the host via `host.docker.internal`.
- **`.env` file** at repo root containing `OPENROUTER_API_KEY=<key>`.
- **Bun 1.3+ installed**; `bun install` has run.
- **Agent images built:** `bun run docker:build` (builds all 4 agents) or individual `bun run docker:build:micah`, etc.
- **Branch in the state you want to test.** Data is transient.

## Agent runtime change checklist

Use this expanded checklist when the change touches container mounts, skill prompts, mail tools, daemon startup, or chat UX — unit tests alone are not sufficient for these surfaces.

1. **Rebuild agent images before verification.** Runtime fixes live in the container image, not the daemon:
   ```bash
   bun run docker:build
   ```
2. **Restart the daemon from a clean state.** Stale data can mask startup issues:
   ```bash
   rm -rf data
   bun run cli serve
   ```
3. **Verify daemon startup logs are clean.** Check for `kill-stale.list-failed`, mount errors, or silent hangs.
4. **Send a round-trip message to every agent.** Each agent must receive mail and reply:
   ```bash
   bun run cli send micah "Reply with exactly: micah-ok"
   bun run cli send doc "Reply with exactly: doc-ok"
   bun run cli send archie "Reply with exactly: archie-ok"
   bun run cli send libby "Reply with exactly: libby-ok"
   ```
5. **For DeepAgents agents (Archie, Libby):** verify mail replies specifically — malformed JSON fallback paths are runtime-only. Check the daemon log for `mail_reply` tool-call diagnostics.
6. **For Pi agents (Micah, Doc):** verify MyFlow skill mounts are present if `TEAMROOM_MYFLOW_PATH` is set. Check daemon startup log for skill-discovery diagnostics.
7. **Verify interactive chat:** `bun run cli chat micah "Check unread mail and report back"` — confirm the CLI preflight succeeds and the WebSocket connects cleanly.
8. **Verify proxy spans reach OpenRouter:** `grep '"event":"model.call.completed"' data/logs/teamroom-*.jsonl | grep '"provider":"openrouter"'`

If any step fails, fix before closeout or explicitly table with a documented decision.

## Scripts reference

All CLI and Docker commands are available as npm scripts:

| Command | What it does |
|---------|-------------|
| `bun run cli serve` | Run the daemon in the foreground |
| `bun run cli send <agent> <message>` | Send a message to an agent |
| `bun run cli chat <agent>` | Start an interactive chat session |
| `bun run cli inbox <agent>` | Show an agent's inbox |
| `bun run cli thread <id>` | View a thread |
| `bun run cli status` | Show daemon status |
| `bun run docker:build` | Build all 4 agent Docker images |
| `bun run docker:build:micah` | Build Micah's image |
| `bun run docker:build:doc` | Build Doc's image |
| `bun run docker:build:archie` | Build Archie's image |
| `bun run docker:build:libby` | Build Libby's image |

Always run CLI commands from the repo root (`/Users/don/projects/teamroom/teamroom`).

## Manual smoke test steps

1. **Build agent images (one-time per code change).**
   ```bash
   bun run docker:build
   ```

2. **Start the daemon (in its own terminal window).**
   ```bash
   rm -rf data
   bun run cli serve
   ```

3. **In a second terminal, send test messages to all 4 agents.**
   ```bash
   bun run cli send micah "Reply with exactly: micah-ok"
   bun run cli send doc "Reply with exactly: doc-ok"
   bun run cli send archie "Reply with exactly: archie-ok"
   bun run cli send libby "Reply with exactly: libby-ok"
   ```

4. **Wait 60-90 seconds, then verify replies.**
   ```bash
   sqlite3 data/teamroom.db \
     "SELECT agent_id, direction, body, created_at FROM messages WHERE direction='out' ORDER BY created_at DESC"
   ```
   Each agent should have an `out` row with its marker word.

5. **Stop the daemon** with `Ctrl+C` in its terminal window.

### Alternative: interactive chat

```bash
bun run cli chat micah "Check unread mail and report back"
```

## Verifying proxy spans

```bash
LOG=$(ls -1t data/logs/teamroom-*.jsonl | head -1)
# All proxy spans:
grep '"event":"model\.' "$LOG" | jq .
# Just the OpenRouter calls:
grep '"event":"model.call.completed"' "$LOG" | grep '"provider":"openrouter"' | jq .
```

## Running Team Room as a macOS service (launchd)

To have Team Room start automatically when you log in:

1. **Install the CLI globally** (one-time):
   ```bash
   bun run install-cli
   # This creates ~/.local/bin/teamroom → src/cli/main.ts
   # The launchd plist expects this exact path
   ```

2. **Copy and customize the launchd plist:**
   ```bash
   cp scripts/teamroom.plist ~/Library/LaunchAgents/dev.teamroom.daemon.plist
   # Edit the file to match your repo path, username, and teamroom binary location
   # The plist's ProgramArguments must point at the same binary that install-cli creates
   ```

3. **Load the service:**
   ```bash
   launchctl load ~/Library/LaunchAgents/dev.teamroom.daemon.plist
   ```

4. **Verify it's running:**
   ```bash
   launchctl list | grep teamroom
   bun run cli status
   ```

5. **Stop / start / unload:**
   ```bash
   launchctl unload ~/Library/LaunchAgents/dev.teamroom.daemon.plist   # stop
   launchctl load ~/Library/LaunchAgents/dev.teamroom.daemon.plist      # start
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
- `docs/specs/2026-04-18-m2-model-abstraction-design.md` — §4 data flow, §6 auth modes, §8 observability.
- `scripts/teamroom.plist` — launchd service definition for auto-start on macOS.
