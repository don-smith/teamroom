# M6 Implementation Plan — DeepAgents runtime + Archie architect

> **For agentic workers:** implement task-by-task. This plan was rescoped 2026-06-06 after merging `main`: Archie/DeepAgents is the M6 deliverable.

**Goal:** Ship Archie as Team Room’s architect agent on a DeepAgents runtime, using persistent lifecycle and the existing mail-MCP + model-proxy substrate.

**Spec:** [`docs/specs/2026-04-22-m6-deepagents-archie-design.md`](../specs/2026-04-22-m6-deepagents-archie-design.md)

## Decisions locked by the rescope

| Decision | Outcome |
|---|---|
| Runtime/provider split | Keep `main`’s split. Archie is `runtime: deepagents`, `provider: lm-studio`. |
| Coding-agent role | Use `main`’s `pi-coder`; do not add a second coding agent in M6. |
| Runtime scope | DeepAgents only for M6. |
| Milestone name | “DeepAgents runtime + Archie architect.” |
| Package/runtime workflow | Use Bun workflow from `main`. |

## Current landed baseline

Already landed before/through the merge:

- `lifecycle: session | persistent` in `AgentConfig`.
- Persistent lifecycle behavior in `SessionTimerManager`.
- Boot-spawn wiring in `composeSessionManagement`.
- DeepAgents submodule at `vendor/deepagents/`.
- Archie scaffold, shim, and Dockerfile under `agents/archie/`.
- Merge from `main`, including Bun runtime and `pi-coder`.
- Reframed Archie config as `runtime: deepagents`, `provider: lm-studio`.

## Task A — Post-merge static baseline

- [x] Merge `main` into `m6-mature-agent`.
- [x] Resolve conflicts toward Bun + runtime/provider split.
- [x] Run `bun install`.
- [x] Run `bun run typecheck`.
- [x] Run targeted tests:

```bash
bun test \
  src/agent-config/agent-config.test.ts \
  src/session-manager/session-manager.test.ts \
  src/modules/session-management/session-management.test.ts \
  src/agent-spec/build-spec.test.ts
```

Expected/current: pass.

- [x] Run full `bun test`.

Expected/current: all non-environmental tests pass. Current known environmental failure: live LM Studio tests fail when no LM Studio model is loaded.

## Task B — Narrow to DeepAgents/Archie

- [x] Remove the superseded second runtime submodule.
- [x] Keep `.gitmodules` to DeepAgents only.
- [x] Keep Docker build scripts to Archie only.
- [x] Keep `deepagents` as a runtime, not a model provider.
- [x] Rewrite M6 spec/plan around DeepAgents + Archie.
- [x] Sweep roadmap/README/tabled docs for stale second-runtime wording.
- [ ] Run a final active-doc/code grep and verify only frozen historical docs mention superseded scope.

## Task C — Archie implementation polish

- [x] Remove ambient `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` selection from `agents/archie/shim.py`; OpenRouter should become explicit provider/fallback config later.
  - If supported: document it and make config naming explicit.
  - If temporary: remove it and route exclusively through Team Room’s proxy.
- [ ] Add first-wake build retry cap in `agents/archie/shim.py`.
  - Repeated MCP/model construction failures should eventually `sys.exit(1)` so daemon respawn/cap behavior engages.
- [ ] Make `/codebase` requirement loud for Archie.
  - Preferred: daemon/config validation for `runtime: deepagents` when no codebase mount is configured, or a clear shim-side startup warning if validation is too invasive.
- [ ] Re-run typecheck and targeted tests.

## Task D — Archie Docker baseline

- [ ] Build the image:

```bash
bun run docker:build:archie
```

- [ ] Run an isolated container smoke if useful:

```bash
docker run --rm -i \
  -e TEAMROOM_AGENT_NAME=archie \
  -e TEAMROOM_PROVIDER=lm-studio \
  -e TEAMROOM_MODEL=qwen/qwen3.6-27b \
  -v "$PWD/agents/archie/AGENTS.md:/AGENTS.md" \
  -v "$PWD/agents/archie/store:/store" \
  -v "$PWD:/codebase" \
  teamroom-agent-archie:latest
```

Expected: process boots and waits for wake envelopes. Full agent construction may wait until first wake and require daemon MCP/model env.

## Task E — Live Team Room acceptance

- [ ] Start daemon with Archie registered and codebase mounted.
- [ ] Verify `session.persistent_boot_spawn` for Archie.
- [ ] Send Archie mail asking for a codebase-grounded architectural observation.
- [ ] Verify Archie:
  - wakes,
  - uses mail-MCP,
  - reads `/codebase`,
  - replies in-thread.
- [ ] Verify persistent lifecycle:
  - container remains alive after reply,
  - daemon shutdown kills it,
  - daemon restart boot-spawns it,
  - simulated crash respawns it within cap.

## Task F — Runbook/docs closeout

- [ ] Update or create the agent-runtime/onboarding runbook material using Archie as the example.
- [ ] Distinguish clearly:
  - runtime onboarding: container/proxy/MCP/wake/lifecycle wiring,
  - persona onboarding: identity/responsibilities/memory/evals.
- [ ] Process M6 entries in `docs/tabled.md`.
- [ ] Update `docs/roadmap.md` at milestone close.
- [ ] Write M6 as-built.
- [ ] Remove in-flight spec/plan after as-built, per docs inventory.

## Validation commands

```bash
bun run typecheck
bun test \
  src/agent-config/agent-config.test.ts \
  src/session-manager/session-manager.test.ts \
  src/modules/session-management/session-management.test.ts \
  src/agent-spec/build-spec.test.ts
bun test
```

`bun test` should pass except explicitly environmental live-model tests when their upstream service/model is absent.
