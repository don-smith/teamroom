# Agent onboarding

> **Scope.** This runbook covers the manual path for adding or updating a Team Room agent in the current harness. It distinguishes **runtime onboarding** (container/proxy/MCP/wake/lifecycle wiring) from **persona onboarding** (identity, role, habits, skills, memory, and evals). M6 proves the split with Archie: an architect persona running on the DeepAgents runtime against OpenRouter.

## Runtime vs. provider vs. persona

- **Runtime** is how the agent runs inside its container. Current values: `anthropic`, `langgraph`, `pi`, `deepagents`.
- **Provider** is the model backend routed through Team Room's model proxy. Current values: `anthropic`, `lm-studio`, `ollama`, `openai`, `openrouter`.
- **Persona** is the team role: e.g. Archie the architect, Pi Coder the coding teammate, Claude Assistant the assistant.

Runtime and provider are intentionally separate. A DeepAgents runtime can use OpenRouter; a Pi runtime can use an OpenAI-compatible provider; Anthropic-specific runtime behavior stays isolated to Anthropic agents.

## What you need before starting

- A short agent name, e.g. `archie` or `pi-coder`.
- A persona reason: what role does this agent fill that an existing agent does not?
- A runtime choice: `anthropic`, `langgraph`, `pi`, or `deepagents`.
- A provider/model choice and credentials in `.env`:
  - `OPENROUTER_API_KEY` for `provider: openrouter`.
  - `OPENAI_TOKEN` for `provider: openai`.
  - `LM_STUDIO_API_TOKEN` / `LM_STUDIO_BASE_URL` for `provider: lm-studio`.
  - Anthropic credentials per [`anthropic-auth.md`](anthropic-auth.md).
- A lifecycle decision:
  - `session` for on-demand containers with idle timeout.
  - `persistent` for always-on team members like Archie.
- If `runtime: deepagents`, `TEAMROOM_CODEBASE_PATH` is required at daemon boot so `/codebase` can be mounted.

## Runtime onboarding steps

1. **Create the agent folder.**

   ```bash
   mkdir -p agents/<name>/store
   touch agents/<name>/store/.gitkeep
   ```

2. **Write `agents/<name>/agent.yaml`.**

   ```yaml
   name: <name>
   runtime: deepagents | langgraph | pi | anthropic
   provider: openrouter | openai | lm-studio | ollama | anthropic
   model: <model-id>
   image_tag: teamroom-agent-<name>:latest
   lifecycle: session | persistent
   subscriptions: []
   ```

   Archie example:

   ```yaml
   name: archie
   runtime: deepagents
   provider: openrouter
   model: deepseek/deepseek-v4-flash
   image_tag: teamroom-agent-archie:latest
   lifecycle: persistent
   subscriptions: []
   ```

3. **Write `agents/<name>/AGENTS.md`.**

   This is the model-facing persona and work-style file mounted at `/AGENTS.md` in the container. Include:

   - role and responsibility,
   - how to use Team Room mail,
   - what to do with `replyExpected` wakes,
   - codebase/file-system expectations,
   - response style.

4. **Write or copy `agents/<name>/Dockerfile`.**

   Use an existing runtime as the closest model:

   - `agents/archie/Dockerfile` for DeepAgents/Python.
   - `agents/pi-coder/Dockerfile` for Pi.
   - `agents/studio-assistant/Dockerfile` for LangGraph/OpenAI-compatible agents.
   - `agents/claude-assistant/Dockerfile` for Anthropic/Claude SDK agents.

5. **Build the image.**

   ```bash
   docker build -t teamroom-agent-<name>:latest -f agents/<name>/Dockerfile .
   ```

   Archie has a package script:

   ```bash
   bun run docker:build:archie
   ```

6. **Start the daemon from the intended worktree.**

   Prefer direct source invocation during worktree testing to avoid stale CLI symlinks:

   ```bash
   TEAMROOM_CODEBASE_PATH="$PWD" bun src/cli/main.ts serve
   ```

   If using the installed `teamroom` binary, refresh the symlink for this worktree:

   ```bash
   bun run install-cli
   ```

7. **Send a first message.**

   ```bash
   bun src/cli/main.ts send <name> "hello"
   ```

8. **Verify mail and logs.**

   ```bash
   bun src/cli/main.ts inbox <name>
   bun src/cli/main.ts thread <thread-id>
   tail -n 200 data/logs/teamroom-*.jsonl
   ```

   For a direct human/CLI message, expect:

   - `mail.delivered` with `messageId`, `threadId`, `from`, and `replyExpected: true`.
   - a wake envelope written to the container.
   - mail-MCP `tool.call` events such as `mail.get` and `mail.reply`.
   - `mail.sent` when the agent replies.

## Persona onboarding steps

Runtime wiring proves the container can run. Persona onboarding proves the teammate is worth having.

For each persona, capture:

- **Identity:** name, role, tone, and what the agent is accountable for.
- **Boundaries:** what the agent should not do yet.
- **Communication protocol:** when to reply in-thread, when silence is acceptable, and how to use Team Room mail.
- **Tools:** which codebase, filesystem, mail, or runtime tools the persona should rely on.
- **Acceptance:** the first concrete task that proves the persona can join the team.

Archie M6 acceptance:

1. daemon boot-spawns Archie as a persistent container;
2. direct mail to Archie wakes the container with `replyExpected: true`;
3. Archie reads the incoming mail;
4. Archie inspects `/codebase`;
5. Archie replies in-thread through mail-MCP with a codebase-grounded architectural observation.

## Reply expectations

Team Room wake envelopes can include structured mail events:

```json
{
  "type": "mail.delivered",
  "to": "archie",
  "messageId": "...",
  "threadId": "...",
  "from": "channel:cli:don",
  "replyExpected": true
}
```

If `replyExpected` is true, the agent should complete the request by replying in-thread through `mail.reply` / `mail_reply`. Final assistant text is diagnostic only; it is not delivered to Team Room. If `replyExpected` is false, the agent should send mail only when doing so adds value.

Archie has an Archie-only safety net: if a reply-required DeepAgents wake ends with final assistant text but no successful `mail_reply`, the shim sends that text through `mail.reply` directly and emits warning telemetry. Treat that as a failure/safety-net path, not normal success.

## Known limitations

- Persistent containers report Docker "Up" before first-wake readiness. DeepAgents builds the graph lazily on first wake, so first-wake latency includes MCP tool discovery and model setup.
- First-wake build retries for Archie are not yet capped; repeated MCP/model construction failures can retry on subsequent wakes without escalating to daemon respawn.
- Durable per-agent memory and formal persona evals are future milestones.

## Related

- [`smoke-test.md`](smoke-test.md) — end-to-end verification of the full stack.
- [`anthropic-auth.md`](anthropic-auth.md) — Anthropic credential setup.
- [`../as-built/`](../as-built/) — shipped architecture records.
- [`../roadmap.md`](../roadmap.md) — future persona/runtime backlog.
