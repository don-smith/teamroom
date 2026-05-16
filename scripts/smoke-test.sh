#!/usr/bin/env bash
# M4.5 smoke test — exercises serve → send → thread for one agent per provider.
# Requires: Bun installed; .env with LM_STUDIO_API_TOKEN; LM Studio running
#   with a model loaded; Docker running; Anthropic credentials discoverable
#   (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env, or
#   ~/.claude/.credentials.json, or — on macOS — the system Keychain entry
#   "Claude Code-credentials").
#
# TODO(manual-acceptance): multi-turn memory check and multi-agent mail
#   round-trip are covered by the seven-scenario manual acceptance pass
#   (Plan Task 38). Promote them back here once stable.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo ".env file required (with LM_STUDIO_API_TOKEN)" >&2
  exit 1
fi

if ! grep -q "^LM_STUDIO_API_TOKEN=" .env; then
  echo "LM_STUDIO_API_TOKEN missing from .env" >&2
  exit 1
fi

have_anthropic_creds=0
if grep -qE "^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=." .env 2>/dev/null; then
  have_anthropic_creds=1
elif [[ -f "$HOME/.claude/.credentials.json" ]]; then
  have_anthropic_creds=1
elif [[ "$(uname -s)" == "Darwin" ]] \
     && security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then
  have_anthropic_creds=1
fi
if [[ "$have_anthropic_creds" == "0" ]]; then
  echo "Anthropic credentials not found." >&2
  echo "  Tried: ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN in .env," >&2
  echo "         ~/.claude/.credentials.json," >&2
  echo "         macOS Keychain entry 'Claude Code-credentials'." >&2
  echo "  Easiest fix: run 'claude setup-token' and paste its output as" >&2
  echo "  CLAUDE_CODE_OAUTH_TOKEN=... in .env. See docs/runbooks/anthropic-auth.md." >&2
  exit 1
fi

LM_STUDIO_HOST_URL="${LM_STUDIO_HOST_URL:-http://localhost:1234}"
echo "==> Checking LM Studio reachable at $LM_STUDIO_HOST_URL"
if ! curl -sS -m 3 -o /dev/null "${LM_STUDIO_HOST_URL}/v1/models"; then
  echo "LM Studio not reachable at $LM_STUDIO_HOST_URL — start it and load a model" >&2
  exit 1
fi

echo "==> Typechecking"
bun run typecheck

echo "==> Building agent images"
docker build -t teamroom-agent-studio-assistant:latest -f agents/studio-assistant/Dockerfile .
docker build -t teamroom-agent-claude-assistant:latest -f agents/claude-assistant/Dockerfile .

DAEMON_PID=""

cleanup() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
  local leftover
  leftover=$(docker ps -q --filter "name=^teamroom-" 2>/dev/null || true)
  if [[ -n "$leftover" ]]; then
    docker rm -f $leftover >/dev/null 2>&1 || true
  fi
  if [[ -n "$DAEMON_PID" ]]; then
    for _ in $(seq 1 20); do
      kill -0 "$DAEMON_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

dump_failure_diagnostics() {
  local agent="$1"
  local thread_id="${2:-}"
  echo "" >&2
  echo "==> Inbox contents for $agent:" >&2
  bun src/cli/main.ts inbox "$agent" 2>&1 || true
  if [[ -n "$thread_id" ]]; then
    echo "" >&2
    echo "==> Thread contents for $agent (thread $thread_id):" >&2
    bun src/cli/main.ts thread "$thread_id" 2>&1 || true
  fi
  echo "" >&2
  echo "==> Last 40 daemon log entries (most recent JSONL file):" >&2
  local log_file
  log_file=$(ls -1t data/logs/teamroom-*.jsonl 2>/dev/null | head -1)
  if [[ -n "$log_file" ]]; then
    tail -n 40 "$log_file" >&2 || true
  else
    echo "  (no daemon log file found at data/logs/teamroom-*.jsonl)" >&2
  fi
  echo "" >&2
  echo "==> Recent docker containers (--filter name=teamroom-, last 5):" >&2
  docker ps -a --filter "name=^teamroom-" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>&1 | head -6 >&2 || true
}

resolve_thread_id() {
  local agent="$1"
  local body="$2"
  local thread_id=""
  for _ in $(seq 1 20); do
    thread_id=$(
      AGENT="$agent" BODY="$body" bun --eval '
        import { Database } from "bun:sqlite";
        const db = new Database("data/teamroom.db", { readonly: true });
        try {
          const row = db
            .query(`SELECT thread_id FROM messages WHERE agent_id = ?1 AND direction = ?2 AND body = ?3 ORDER BY created_at DESC LIMIT 1`)
            .get(process.env.AGENT, "in", process.env.BODY) as { thread_id: string | null } | null;
          if (row?.thread_id) process.stdout.write(row.thread_id);
        } finally {
          db.close();
        }
      '
    )
    if [[ -n "$thread_id" ]]; then
      printf '%s\n' "$thread_id"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

thread_has_outbound_marker() {
  local thread_id="$1"
  local marker="$2"
  bun src/cli/main.ts thread "$thread_id" 2>/dev/null | MARKER="$marker" bun --eval '
    const marker = process.env.MARKER ?? "";
    const input = await Bun.stdin.text();
    for (const line of input.split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as { direction?: string; body?: unknown };
      if (row.direction === "out" && typeof row.body === "string" && row.body.includes(marker)) {
        process.exit(0);
      }
    }
    process.exit(1);
  '
}

echo "==> Starting daemon in background"
rm -rf data
bun src/cli/main.ts serve &
DAEMON_PID=$!

# Wait for the daemon to signal it's up (pid file).
for _ in $(seq 1 50); do
  [[ -f data/teamroom.pid ]] && break
  sleep 0.1
done
if [[ ! -f data/teamroom.pid ]]; then
  echo "daemon failed to start" >&2
  exit 1
fi

# Send a message to an agent, resolve the new thread id, then poll the full
# thread until an outbound reply row contains the marker.
run_agent() {
  local agent="$1"
  local marker="$2"
  local prompt="Hello from the smoke test — reply with exactly: $marker"
  local thread_id=""
  echo "==> Sending to $agent (expect: $marker)"
  bun src/cli/main.ts send "$agent" "$prompt"
  echo "==> Resolving thread id for $agent"
  if ! thread_id=$(resolve_thread_id "$agent" "$prompt"); then
    echo "==> FAIL: could not resolve thread id for $agent send" >&2
    dump_failure_diagnostics "$agent"
    return 1
  fi
  echo "==> Waiting for $agent outbound reply on thread $thread_id (up to 60s)"
  for _ in $(seq 1 120); do
    if thread_has_outbound_marker "$thread_id" "$marker"; then
      echo "==> $agent OK (thread $thread_id)"
      return 0
    fi
    sleep 0.5
  done
  echo "==> FAIL: $agent did not produce an outbound reply with '$marker' on thread $thread_id" >&2
  dump_failure_diagnostics "$agent" "$thread_id"
  return 1
}

run_agent studio-assistant "studio-ok"
run_agent claude-assistant "claude-ok"

echo "==> Verifying both providers' spans in the daemon log"
LOG_FILE=$(ls -1t data/logs/teamroom-*.jsonl 2>/dev/null | head -1)
if [[ -z "$LOG_FILE" ]]; then
  echo "==> FAIL: no daemon log file found" >&2
  exit 1
fi
if ! grep -q '"provider":"anthropic"' "$LOG_FILE"; then
  echo "==> FAIL: no anthropic model.call.completed span in $LOG_FILE" >&2
  exit 1
fi
if ! grep -q '"provider":"lm-studio"' "$LOG_FILE"; then
  echo "==> FAIL: no lm-studio model.call.completed span in $LOG_FILE" >&2
  exit 1
fi

echo "==> SMOKE PASS — both agents responded; both providers' spans present"
