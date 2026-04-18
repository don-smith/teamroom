# Agent onboarding (skeleton)

> **This is a starting point.** Real specialized-agent onboarding will involve flowcharts, skill assignments, tool inventories, and metadata that M2 does not yet model. The expectation is that an agent role is observed-in-use before it is formally onboarded; the skeleton supports the manual path that exists today.

## What you need before starting

- A short name for the agent (e.g., `claude-assistant`). Convention: name agents after their backing model/provider unless the role is more important than the model.
- A model + provider decision: either `provider: anthropic` with a Claude model, or `provider: lm-studio` with a local model (LM Studio must be running with the chosen model loaded).
- Credentials wired in `.env` (see [`anthropic-auth.md`](anthropic-auth.md) for the Anthropic case).

## Steps

1. **Create the agent folder.**

   ```bash
   mkdir -p agents/<name>/store
   touch agents/<name>/store/.gitkeep
   ```

2. **Write `agents/<name>/agent.yaml`:**

   ```yaml
   name: <name>
   provider: anthropic | lm-studio
   model: <model-id>
   image_tag: teamroom-agent-<name>:latest
   ```

3. **Write `agents/<name>/AGENTS.md`** — the model-facing instructions for this agent. Be specific about tone, scope, and any per-agent constraints. This file is mounted writable into the container at `/AGENTS.md`.

4. **Write `agents/<name>/Dockerfile`** — copy from `agents/studio-assistant/Dockerfile` or `agents/claude-assistant/Dockerfile`; change the image tag if needed.

5. **Build the agent's image:**

   ```bash
   npm run build
   docker build -t teamroom-agent-<name>:latest -f agents/<name>/Dockerfile .
   ```

6. **Restart the daemon** so it discovers and registers the new agent on startup.

7. **Send a first message:**

   ```bash
   teamroom send --agent <name> "hello"
   teamroom tail
   ```

8. **Verify in the log** at `data/logs/teamroom-YYYY-MM-DD.jsonl`:

   ```bash
   grep '"agentName":"<name>"' data/logs/teamroom-*.jsonl | head
   ```

   Expect to see `turn.started`, `model.call.completed`, `turn.completed` events for your message.

## What this skeleton does NOT cover yet

- Skill assignments and tool inventories (M3+).
- Per-agent memory (M4).
- Per-agent evaluations (M6).
- Self-improvement loops (M7).

When those land, this runbook will get richer; for now it's the manual cookbook.

## Related

- [`anthropic-auth.md`](anthropic-auth.md) — credential setup for `provider: anthropic` agents.
- [`smoke-test.md`](smoke-test.md) — end-to-end verification of the full stack.
- [`docs/specs/2026-04-18-m2-model-abstraction-design.md`](../specs/2026-04-18-m2-model-abstraction-design.md) — §3.4 agent population, §3.6 onboarding context.
