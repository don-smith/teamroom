#!/usr/bin/env bash
# M1 smoke test — exercises the full stack end-to-end.
# Requires: .env with LM_STUDIO_API_TOKEN; LM Studio running on localhost with the configured model loaded; Docker running.
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

LM_STUDIO_HOST_URL="${LM_STUDIO_HOST_URL:-http://localhost:1234}"
echo "==> Checking LM Studio reachable at $LM_STUDIO_HOST_URL"
if ! curl -sS -m 3 -o /dev/null "${LM_STUDIO_HOST_URL}/v1/models"; then
  echo "LM Studio not reachable at $LM_STUDIO_HOST_URL — start it and load a model" >&2
  exit 1
fi

echo "==> Building TypeScript"
npm run build

echo "==> Building agent image"
docker build -t teamroom-agent-studio-assistant:latest -f agents/studio-assistant/Dockerfile .

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

echo "==> Sending a message"
node dist/cli/main.js send "Hello from the smoke test — reply with exactly: hello back"

echo "==> Waiting for reply (up to 60s)"
for _ in $(seq 1 120); do
  if grep -q "hello back" /tmp/teamroom-smoke-output.txt 2>/dev/null; then
    break
  fi
  sleep 0.5
done

kill "$TAIL_PID" 2>/dev/null || true

echo "==> Output:"
cat /tmp/teamroom-smoke-output.txt

if grep -q "hello back" /tmp/teamroom-smoke-output.txt 2>/dev/null; then
  echo "==> SMOKE PASS"
else
  echo "==> SMOKE FAIL — expected reply not found" >&2
  exit 1
fi

echo "==> Stopping daemon"
kill "$DAEMON_PID" 2>/dev/null || true
wait "$DAEMON_PID" 2>/dev/null || true
