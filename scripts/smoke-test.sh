#!/usr/bin/env bash
# M2 smoke test — exercises both agents end-to-end through the model-proxy.
# Requires: .env with LM_STUDIO_API_TOKEN; LM Studio running with a model loaded;
#   Docker running; Anthropic credentials discoverable (CLAUDE_CODE_OAUTH_TOKEN
#   or ANTHROPIC_API_KEY in .env, or ~/.claude/.credentials.json, or — on
#   macOS — the system Keychain entry "Claude Code-credentials").
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

echo "==> Building TypeScript"
npm run build

echo "==> Building agent images"
docker build -t teamroom-agent-studio-assistant:latest -f agents/studio-assistant/Dockerfile .
docker build -t teamroom-agent-claude-assistant:latest -f agents/claude-assistant/Dockerfile .

DAEMON_PID=""
TAIL_PID=""

cleanup() {
  # Kill in the order: tail (cheap), daemon (so it stops spawning containers),
  # then force-remove any agent containers that lingered. Suppress all errors —
  # cleanup is best-effort and runs even when nothing was started.
  if [[ -n "$TAIL_PID" ]]; then
    kill "$TAIL_PID" 2>/dev/null || true
  fi
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
  # Stop+remove any leftover teamroom-* containers (named per turn-processor.ts).
  local leftover
  leftover=$(docker ps -q --filter "name=^teamroom-" 2>/dev/null || true)
  if [[ -n "$leftover" ]]; then
    docker rm -f $leftover >/dev/null 2>&1 || true
  fi
  # Wait briefly for the daemon's own teardown to complete; don't hang on it.
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
  echo "" >&2
  echo "==> Tail output (outbound messages we received):" >&2
  cat /tmp/teamroom-smoke-output.txt >&2 || true
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

echo "==> Starting daemon in background"
rm -rf data
node dist/cli/main.js serve &
DAEMON_PID=$!

# Wait for the daemon to signal it's up (pid file + agent registration).
for _ in $(seq 1 50); do
  [[ -f data/teamroom.pid ]] && break
  sleep 0.1
done
if [[ ! -f data/teamroom.pid ]]; then
  echo "daemon failed to start" >&2
  exit 1
fi

echo "==> Starting tail in background"
node dist/cli/main.js tail > /tmp/teamroom-smoke-output.txt &
TAIL_PID=$!

sleep 0.5

run_agent() {
  local agent="$1"
  local marker="$2"
  echo "==> Sending to $agent (expect: $marker)"
  : > /tmp/teamroom-smoke-output.txt
  node dist/cli/main.js send --agent "$agent" "Hello from the smoke test — reply with exactly: $marker"
  echo "==> Waiting for $agent reply (up to 60s)"
  for _ in $(seq 1 120); do
    if grep -q "$marker" /tmp/teamroom-smoke-output.txt 2>/dev/null; then
      echo "==> $agent OK"
      return 0
    fi
    sleep 0.5
  done
  echo "==> FAIL: $agent did not reply with '$marker'" >&2
  dump_failure_diagnostics "$agent"
  return 1
}

# Two-turn conversation memory check. Sends a unique codeword in turn 1, asks
# for it back in turn 2. If conversation history is broken (container's
# runtime not loading conversation.jsonl, or claude-agent-sdk session not
# resuming, etc.) turn 2 won't recall and the smoke test fails. Each agent
# gets its own codeword so failure messages are unambiguous.
run_multiturn_check() {
  local agent="$1"
  # 8 random hex chars — unique per smoke run so accumulated history from
  # prior runs can't accidentally satisfy the assertion.
  local codeword="cw-$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 8)"

  echo "==> [multi-turn] Sending to $agent — turn 1 (codeword: $codeword)"
  : > /tmp/teamroom-smoke-output.txt
  node dist/cli/main.js send --agent "$agent" "Remember this codeword: $codeword. Reply with exactly: ack-mt"
  echo "==> [multi-turn] Waiting for $agent turn-1 ack (up to 60s)"
  local ok=0
  for _ in $(seq 1 120); do
    if grep -q "ack-mt" /tmp/teamroom-smoke-output.txt 2>/dev/null; then ok=1; break; fi
    sleep 0.5
  done
  if [[ "$ok" != "1" ]]; then
    echo "==> FAIL: $agent multi-turn turn 1 didn't ack with 'ack-mt'" >&2
    dump_failure_diagnostics "$agent"
    return 1
  fi

  echo "==> [multi-turn] Sending to $agent — turn 2 (recall codeword)"
  : > /tmp/teamroom-smoke-output.txt
  node dist/cli/main.js send --agent "$agent" "What was the codeword I just told you? Reply with just the codeword, nothing else."
  echo "==> [multi-turn] Waiting for $agent to recall '$codeword' (up to 60s)"
  for _ in $(seq 1 120); do
    if grep -q "$codeword" /tmp/teamroom-smoke-output.txt 2>/dev/null; then
      echo "==> [multi-turn] $agent OK (recalled $codeword)"
      return 0
    fi
    sleep 0.5
  done
  echo "==> FAIL: $agent multi-turn turn 2 didn't recall codeword '$codeword' — conversation history broken" >&2
  dump_failure_diagnostics "$agent"
  return 1
}

run_dm_primitive_check() {
  local unique="dm-$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 8)"
  local prompt="Send a DM to studio-assistant with body '${unique}'. To do this, emit a JSON line to stdout: {\"type\":\"dm\",\"to\":\"studio-assistant\",\"body\":\"${unique}\"}. Then stop — do not reply."

  echo "==> [dm-primitive] Sending DM trigger to claude-assistant (unique: $unique)"
  : > /tmp/teamroom-smoke-output.txt
  node dist/cli/main.js send --agent claude-assistant "$prompt"

  echo "==> [dm-primitive] Waiting up to 90s for DM chain to complete"
  local elapsed=0
  local all_settled=0
  while [[ "$elapsed" -lt 90 ]]; do
    sleep 3
    elapsed=$((elapsed + 3))

    local pending_or_running
    pending_or_running=$(node -e "
      const db = require('better-sqlite3')('data/teamroom.db', { readonly: true });
      const rows = db.prepare(\"SELECT COUNT(*) AS c FROM turns WHERE status IN ('pending','running')\").get();
      db.close();
      process.stdout.write(String(rows.c));
    " 2>/dev/null || echo "1")

    if [[ "$pending_or_running" == "0" ]]; then
      all_settled=1
      break
    fi
  done

  local fail=0

  if [[ "$all_settled" != "1" ]]; then
    echo "==> [dm-primitive] FAIL: turns did not all settle within 90s" >&2
    fail=1
  fi

  local claude_to_studio
  claude_to_studio=$(node -e "
    const db = require('better-sqlite3')('data/teamroom.db', { readonly: true });
    const row = db.prepare(\"SELECT COUNT(*) AS c FROM messages WHERE channel='dm' AND topic='studio-assistant' AND from_agent_id='claude-assistant'\").get();
    db.close();
    process.stdout.write(String(row.c));
  " 2>/dev/null || echo "0")

  if [[ "$claude_to_studio" -lt 1 ]]; then
    echo "==> [dm-primitive] FAIL: no DM row from claude-assistant to studio-assistant (channel=dm, topic=studio-assistant)" >&2
    fail=1
  else
    echo "==> [dm-primitive] claude->studio DM row found ($claude_to_studio)"
  fi

  local studio_to_claude
  studio_to_claude=$(node -e "
    const db = require('better-sqlite3')('data/teamroom.db', { readonly: true });
    const row = db.prepare(\"SELECT COUNT(*) AS c FROM messages WHERE channel='dm' AND topic='claude-assistant' AND from_agent_id='studio-assistant'\").get();
    db.close();
    process.stdout.write(String(row.c));
  " 2>/dev/null || echo "0")

  if [[ "$studio_to_claude" -lt 1 ]]; then
    echo "==> [dm-primitive] FAIL: no return DM row from studio-assistant to claude-assistant (channel=dm, topic=claude-assistant)" >&2
    fail=1
  else
    echo "==> [dm-primitive] studio->claude return DM row found ($studio_to_claude)"
  fi

  local bad_errors
  bad_errors=$(node -e "
    const db = require('better-sqlite3')('data/teamroom.db', { readonly: true });
    const rows = db.prepare(\"SELECT id, error FROM turns WHERE status='error' AND error IS NOT 'conversation_cap'\").all();
    db.close();
    process.stdout.write(String(rows.length));
  " 2>/dev/null || echo "1")

  if [[ "$bad_errors" -gt 0 ]]; then
    echo "==> [dm-primitive] FAIL: $bad_errors turn(s) with unexpected error value (not conversation_cap)" >&2
    node -e "
      const db = require('better-sqlite3')('data/teamroom.db', { readonly: true });
      const rows = db.prepare(\"SELECT id, agent_id, status, error FROM turns WHERE status='error' AND error IS NOT 'conversation_cap'\").all();
      db.close();
      console.error(JSON.stringify(rows, null, 2));
    " 2>&1 >&2 || true
    fail=1
  fi

  if [[ "$fail" == "1" ]]; then
    dump_failure_diagnostics "dm-primitive"
    return 1
  fi

  echo "==> [dm-primitive] PASS — DM chain round-tripped and all turns settled"
}

run_agent studio-assistant "studio-ok"
run_multiturn_check studio-assistant
run_agent claude-assistant "claude-ok"
run_multiturn_check claude-assistant
run_dm_primitive_check

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
