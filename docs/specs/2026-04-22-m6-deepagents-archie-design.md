# M6 — DeepAgents runtime + Archie architect

*Spec. 2026-04-22; rescoped 2026-06-06 after merging `main`. In-flight; superseded by the M6 as-built at close.*

## 1. Context and rescope

After `main` shipped `pi-coder` as the coding agent and migrated the project to Bun, this branch is narrowed to the most valuable M6 outcome: **Archie, an architect persona, running on DeepAgents**.

The product learning is sharp: Team Room can host a mature external agent framework without owning every internal agent-loop detail. DeepAgents is the right level of abstraction for this first proof because it gives us filesystem/tool/skill-oriented agent construction without adopting a heavy all-in-one harness.

## 2. Terminology

- **Team harness.** Team Room itself: mail, shared codebase, model proxy, lifecycle, observability.
- **Agent runtime.** The process model inside one agent container. Existing examples: `anthropic`, `langgraph`, `pi`; M6 adds `deepagents`.
- **Model provider.** The model backend routed through the daemon proxy: `anthropic`, `lm-studio`, `ollama`, or `openai`. Runtime and provider are intentionally separate after the `main` merge.
- **Persona.** A named team role. M6 pre-claims **Archie**, the architect.
- **Agent onboarding.** Teaching a persona its identity, responsibilities, skill use, and readiness criteria. M6 captures first runbook lessons but does not fully solve durable persona onboarding.

## 3. Scope

### In scope

1. Persistent agent lifecycle support: long-lived containers, boot spawn, no idle timeout, daemon-managed respawn.
2. A new `deepagents` runtime value in agent config, separate from model provider.
3. Archie under `agents/archie/`:
   - `agent.yaml`
   - `AGENTS.md`
   - `Dockerfile`
   - `shim.py`
   - `store/.gitkeep`
4. Vendored DeepAgents source at `vendor/deepagents/`.
5. Runbook updates for onboarding an agent/runtime, grounded in Archie.
6. Acceptance showing Archie can receive mail, inspect `/codebase`, and reply.

### Out of scope

1. Additional external runtimes beyond DeepAgents.
2. A generic third-party harness marketplace.
3. DeepAgents shell execution beyond what Archie needs for M6 acceptance.
4. Durable per-agent memory design; M7 remains the memory milestone.
5. Full persona onboarding/evals for Archie; M6 makes Archie operational, not fully mature.

## 4. Runtime contract

A Team Room agent runtime must satisfy:

1. **Lifecycle.** `agent.yaml` declares `lifecycle: session | persistent`. Archie uses `persistent`.
2. **Entry point.** The container reads JSON wake envelopes from stdin: `{ "type": "wake", "events": [...] }`.
3. **Mail-MCP.** The runtime uses `TEAMROOM_MCP_URL` and `TEAMROOM_MCP_TOKEN` to call Team Room mail tools.
4. **Codebase mount.** `/codebase` is the shared working tree mount. Archie’s persona assumes it exists.
5. **Model proxy.** The runtime receives `TEAMROOM_MODEL_BASE_URL`, `TEAMROOM_MODEL_API_TOKEN`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN`; `provider` remains the model provider (`openrouter` for Archie in the current acceptance path).
6. **Docker image.** Each runtime owns its image and shim, but the daemon treats the container as opaque beyond stdin wakes and lifecycle.

### 4.1 Mail wake reply obligations

Mail wakes are no longer only string tags. `mail.delivered` events include the minimum metadata needed for a runtime to account for communication protocol:

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

For M6, direct human/CLI-to-agent and direct agent-to-agent `to:` mail sets `replyExpected: true`; list fanout and cc-style deliveries set `replyExpected: false`. Runtimes may still receive legacy string wake tags and should handle them by checking mail normally.

The key protocol rule: final assistant text is diagnostic only. If a wake has `replyExpected: true`, the agent should complete the request by replying in-thread through mail-MCP. If `replyExpected: false`, the agent may remain silent unless sending mail adds value. This avoids both lost replies and noisy agents.

Archie has an **Archie-only** safety net, not a generic runtime rule: when a reply-required wake ends with final assistant text but no successful `mail_reply` tool result, the shim sends that final text through `mail.reply` directly. This is intentionally treated as a failure/safety-net path, not normal success. Archie emits structured runtime telemetry for both malformed tool calls (`agent.tool_call.invalid`) and fallback usage (`agent.reply_required.fallback_used`); the session manager publishes those events onto the Team Room event bus and the daemon logs them at warn level.

This shape deliberately leaves room for future channel-specific response expectations, such as a Telegram voice sidecar that post-processes a mail reply into a spoken response. The agent should express the reply through Team Room mail; Team Room/channel infrastructure can perform sidecar rendering later.

## 5. Architecture

### 5.1 Agent config

Archie uses the post-`main` split:

```yaml
name: archie
runtime: deepagents
provider: openrouter
model: deepseek/deepseek-v4-flash
image_tag: teamroom-agent-archie:latest
lifecycle: persistent
subscriptions: []
```

`runtime: deepagents` selects the container entrypoint/runtime shape. `provider: openrouter` selects OpenAI-compatible proxy token routing to OpenRouter.

### 5.2 Persistent lifecycle

Persistent behavior:

- Container spawns once at daemon boot via session-management init.
- Stdin pipe remains open for the container lifetime.
- Idle timer is skipped.
- Unexpected exit triggers daemon-managed respawn with a cap to avoid crash loops.
- Daemon shutdown kills containers without respawn.

No Docker `--restart` flag is used; daemon-managed respawn preserves stdin ownership and observability.

### 5.3 Archie / DeepAgents

Archie’s Python shim:

- Reads stdin wake envelopes.
- Builds a DeepAgents graph lazily on first wake.
- Discovers Team Room mail tools via MCP.
- Uses DeepAgents filesystem support rooted at `/codebase`.
- Uses a SQLite LangGraph checkpointer under `/store`.
- Routes model calls through Team Room’s Anthropic proxy by default, with the current OpenRouter debug path left as an implementation detail to verify before close.

## 6. Acceptance

M6 closes when:

1. Typecheck passes under Bun.
2. The test suite passes, except for explicitly environmental live-model tests if their upstream model is not running.
3. Archie image builds.
4. Daemon boot-spawns Archie as a persistent container.
5. A mail to Archie wakes the container.
6. Archie reads codebase content under `/codebase` and replies in-thread through mail-MCP.
7. Daemon restart/Archie crash behavior proves persistent lifecycle still works after the `main` merge.
8. Docs/runbook reflect the `runtime`/`provider` split and the narrowed Archie-only M6 scope.

## 7. Known follow-ups before close

- Decide how OpenRouter should become an explicit provider or fallback configuration rather than an ambient `OPENROUTER_*` shortcut.
- Cap first-wake DeepAgents build retries so repeated MCP/model construction failures eventually surface to daemon respawn.
- Make the `/codebase` requirement loud for `runtime: deepagents` or document the operator requirement clearly.
- Document that Docker “Up” means process booted, not necessarily first-wake readiness.

## Related

- [Plan](../plans/2026-04-22-m6-deepagents-archie-plan.md)
- [Roadmap](../roadmap.md)
- [M5 as-built](../as-built/2026-04-22-teamroom-m5.md)
