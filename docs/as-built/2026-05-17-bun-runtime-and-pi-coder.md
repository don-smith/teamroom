# Bun Runtime + Pi Coder — As Built

*Date: 2026-05-17. Frozen at commit. Future changes happen in a new as-built, not here.*

## 1. What was delivered

This branch closes two tightly-coupled pieces of work into one shipped shape:

- Team Room's host CLI, test suite, install flow, and agent containers now run on Bun directly from source rather than a Node build/dist pipeline.
- `pi-coder` is now part of that Bun-based runtime tree as a first-class `runtime: pi` agent, integrated through the same Team Room mail substrate, container contract, and model-proxy credential boundary as the existing agents.

The resulting branch shape is:

- `bun test` and `bun run typecheck` are the default verification commands.
- `teamroom` executes `src/cli/main.ts` directly via Bun.
- agent images run `bun /app/src/agent-runtime/main.ts` rather than a compiled `dist/` entrypoint.
- `studio-assistant` remains on LM Studio, `claude-assistant` remains on Anthropic, and `pi-coder` uses the hosted OpenAI provider through Team Room's proxy.

Live acceptance succeeded against the real environment at close-out:

- `bun run typecheck` passed.
- `bun test` passed: 329 tests across 63 files.
- `./scripts/smoke-test.sh` passed end-to-end.
- the live daemon spans for `studio-assistant` during the smoke run showed `provider:"lm-studio"` and `model:"openai/gpt-oss-20b"`.

## 2. Architecture as built

### Bun is now the execution substrate

The repository no longer treats Node + compiled `dist/` output as the primary runtime path.

- `package.json` points the CLI `bin` at `src/cli/main.ts`.
- the install script is `scripts/install-cli.ts`, run by Bun.
- the lockfile of record is `bun.lock`.
- test files use `bun:test`, and the default test command is `bun test`.

The three existing agent images now follow Bun-first container patterns:

- `agents/studio-assistant/Dockerfile` and `agents/pi-coder/Dockerfile` use `oven/bun:1.3-alpine`
- `agents/claude-assistant/Dockerfile` and `agents/claude-researcher/Dockerfile` use `oven/bun:1.3`
- all four copy `src/` and execute `bun /app/src/agent-runtime/main.ts`

This keeps host and container execution paths aligned: the same source tree runs in both places, and there is no separate build artifact boundary to drift.

### Runtime is separate from provider

The merged tree now makes the runtime/provider distinction explicit:

- `Provider = "anthropic" | "lm-studio" | "ollama" | "openai"`
- `AgentRuntime = "anthropic" | "langgraph" | "pi"`

`loadAgentConfig()` infers runtime for legacy shapes:

- `provider: anthropic` -> `runtime: anthropic`
- `provider: lm-studio | ollama | openai` -> `runtime: langgraph`

and also accepts explicit overrides where they are real:

- `pi-coder` declares `runtime: pi`, `provider: openai`, `model: openai/gpt-5.5`

This split is now enforced rather than being purely descriptive. Invalid pairings such as `runtime: anthropic` with `provider: openai` or `runtime: langgraph` with `provider: anthropic` are rejected at config load so protocol mismatches fail fast instead of producing broken model calls later.

### Pi runtime integration

`src/agent-runtime/pi-worker.ts` introduces the Pi SDK worker path under the Bun runtime tree.

At boot it:

- builds a Pi `models.json` file from Team Room env (`TEAMROOM_PROVIDER`, `TEAMROOM_MODEL`, `TEAMROOM_MODEL_BASE_URL`, `TEAMROOM_MODEL_API_TOKEN`)
- points Pi at the Team Room proxy rather than exposing real upstream credentials in-container
- registers Team Room mail as Pi-native tools (`mail_list`, `mail_get`, `mail_send`, `mail_reply`, `mail_mark_read`, `mail_archive`, `mail_delete`)

One important post-merge fix landed before close-out: Pi's tool allowlist is strict, so the worker now always preserves those Team Room mail tools in the resolved Pi allowlist even when the agent config declares only built-in coding tools such as `read`, `write`, `edit`, and `bash`.

### Conditional hosted-provider credentials

`teamroom serve` now reads configured agents before enforcing provider-specific secrets.

- `LM_STUDIO_API_TOKEN` remains required for the current local-model path.
- `OPENAI_TOKEN` is required only when at least one configured agent uses `provider: openai`.

That preserves existing LM Studio + Anthropic workflows while still supporting `pi-coder` on hosted OpenAI.

## 3. Design adaptations during close-out

- **Merge local `main`, keep Bun authoritative.**
  `main` brought in `pi-coder`, runtime/provider split, and OpenAI provider wiring, but also a Node/dist/package-lock shape. The shipped branch keeps the Bun runtime authoritative and ports the Pi path onto it instead of reintroducing Node as a parallel primary path.

- **Fix smoke truthfulness before accepting the migration.**
  The Bun migration branch tightened the smoke script to validate thread-local outbound replies and exact reply bodies. That removed earlier false-positive behavior and made the later LM Studio failures honest.

- **Use the real LM Studio model that actually survives the live mail loop.**
  Earlier local-model attempts proved that passing the direct proxy integration test is not enough; the live agent wake/tool/reply path is the real acceptance boundary. At close-out, `openai/gpt-oss-20b` in LM Studio completed the real smoke flow successfully.

- **Replace the premature Pi as-built rather than preserve a wrong frozen artifact.**
  The merged `docs/as-built/2026-05-16-pi-coder-openai.md` described the pre-Bun Node/dist landing and claimed close-out that had not happened on this branch. It was removed and replaced with this as-built so the permanent record matches the shipped branch shape.

## 4. Verification

Fresh verification at close-out:

- `bun run typecheck`
- `bun test`
  Result: 329 pass / 0 fail
- `./scripts/smoke-test.sh`
  Result: pass
  - `studio-assistant` replied successfully
  - `claude-assistant` replied successfully
  - daemon spans showed both providers
  - `studio-assistant` spans specifically showed `model:"openai/gpt-oss-20b"`

The branch was also left in a clean runtime state after verification:

- `teamroom status` -> `daemon: not running`
- no `teamroom-*` containers left running

## 5. Scaffolding purged

Per the project close-out rule, the in-flight planning docs for this work were removed:

- `docs/plans/2026-05-16-bun-runtime-design.md`
- `docs/plans/2026-05-16-bun-runtime-plan.md`
- `docs/plans/2026-05-16-pi-agent-design.md`
- `docs/plans/2026-05-16-pi-agent-implementation.md`

The `docs/plans/` folder is back to its between-milestones resting shape.

## 6. Known follow-ups

- The root roadmap still says M5.1 is next; this branch did not re-scope the milestone ordering, so roadmap edits are deferred until a real milestone-close decision changes the queue.
- `pi-coder` is integrated and buildable on Bun, but this close-out did not add a dedicated `pi-coder` live smoke path. The verified smoke path remains `studio-assistant` + `claude-assistant`.
- `docs/runbooks/agent-onboarding.md` remains an older shape already called out in backlog; this branch did not rewrite it.

## 7. Related

- [M5 as-built](2026-04-22-teamroom-m5.md) — predecessor runtime shape that this branch extends and operationalizes on Bun.
- [docs/roadmap.md](../roadmap.md) — still-current milestone ordering.
- [README.md](../../README.md) — updated host/operator-facing entrypoint for the closed branch shape.
