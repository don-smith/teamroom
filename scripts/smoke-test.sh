#!/usr/bin/env bash
# M2 smoke test — exercises both agents end-to-end through the model-proxy.
# Requires: .env with LM_STUDIO_API_TOKEN; LM Studio running with a model loaded;
#   Docker running; Anthropic credentials discoverable (CLAUDE_CODE_OAUTH_TOKEN
#   or ANTHROPIC_API_KEY in .env, or ~/.claude/.credentials.json).
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

if ! grep -qE "^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=" .env 2>/dev/null \
   && [[ ! -f "$HOME/.claude/.credentials.json" ]]; then
  echo "Anthropic credentials not found (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in .env, or ~/.claude/.credentials.json)" >&2
  echo "See docs/runbooks/anthropic-auth.md" >&2
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

echo "==> Starting daemon in background"
rm -rf data
node dist/cli/main.js serve &
DAEMON_PID=$!
trap "kill $DAEMON_PID 2>/dev/null || true; wait 2>/dev/null || true" EXIT

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
      return 0
    fi
    sleep 0.5
  done
  echo "==> FAIL: $agent did not reply with '$marker'" >&2
  cat /tmp/teamroom-smoke-output.txt
  return 1
}

run_agent studio-assistant "studio-ok"
run_agent claude-assistant "claude-ok"

kill "$TAIL_PID" 2>/dev/null || true

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

echo "==> Stopping daemon"
kill "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true
