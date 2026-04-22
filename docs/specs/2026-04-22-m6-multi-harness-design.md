# M6 — Multi-Harness Agent Integrations (Archie + Dev)

*Spec. 2026-04-22. In-flight; superseded by the M6 as-built at close.*

## 1. Context and pivot

Team Room started as a **bottom-up build** premise: own each agent's skills, context, memory, and identity from the ground up, then add them to the team. M1–M5.1 have been consistent with that — our Claude-Code-based agents and the LangGraph-based `studio-assistant` each use Team Room as both the team harness *and* the agent harness.

M6 inverts the premise. We plug in **production-ready external agent harnesses** — DeepAgents and Hermes — without owning their internal agent-skills/context/memory work. We gain team diversity *now*, in exchange for incomplete persona-level onboarding *later*. From the user framing during brainstorm:

> I'm offering a different way through Team Room which is to start to incorporate good memory and practices in your codebase routines and operations now, and then you can bring those in to an agent later. We're kind of speed-running that at the moment so that we can create agents and try to get them to talk to each other and collaborate before we really have told them what the mission is.

The expected learning is dual: (a) whether Team Room's substrate is actually harness-agnostic as designed, and (b) *why* the bottom-up approach matters — surfaced by the gaps we will feel with harnesses whose skills/context we didn't build.

## 2. Terminology

This milestone clarifies a naming collision that has been implicit:

- **Team harness.** Team Room itself. Provides mail, shared codebase, threaded discussions, observability (eventually evals). The substrate that hosts a team.
- **Agent harness.** The runtime for one team member. Can be **internal** — Team Room itself serves as the agent harness, as with `studio-assistant` (LangGraph + ChatOpenAI) and our `claude-*` agents (claude-agent-sdk). Or **external** — a self-contained third-party harness, as with DeepAgents and Hermes.
- **Persona.** A named team role (architect, developer, PM, etc.), from the roadmap's persona backlog. Personas are filled by agent instances.
- **Agent instance.** One concrete team member: an `archie` (persona: architect) on the DeepAgents harness; a `dev` (persona: developer) on the Hermes harness.
- **Agent onboarding.** The future work of teaching one specific agent instance its identity, purpose, responsibilities, not-to-do's, skills, context, and memory. **Out of M6 scope** — gated on memory (M7) and codebase-practice infrastructure. Lives in the (still-skeletal) `docs/runbooks/agent-onboarding.md`.
- **Agent-harness onboarding.** The in-scope work of this milestone: the procedure for provisioning a new agent harness (internal or external) so that it can participate in the team via mail + codebase. Will live in a new `docs/runbooks/onboarding-an-agent-harness.md`.

## 3. Scope

### 3.1 In scope

1. Substrate changes to support persistent, externally-harness-hosted agents.
2. Two new agent instances: **Archie** on DeepAgents, **Dev** on Hermes.
3. A new runbook: `docs/runbooks/onboarding-an-agent-harness.md`.
4. Manual acceptance scenarios (S1–S4, §11).

### 3.2 Out of scope

1. **Agent onboarding** (the persona-skills/context/memory work). The existing `docs/runbooks/agent-onboarding.md` is preserved untouched; it remains a future artifact.
2. **Inside-out mail polling.** Hermes's built-in `cronjob` is inherited as a capability but not used for mail in M6; future subscription-driven work (likely M8) can revisit.
3. **Proxy extensions for new model providers** (OpenRouter, Nous, etc.) unless a chosen model forces them. Decision made at plan time.
4. **Git-state-aware codebase layout.** Both harnesses ship shell + git; whether `/codebase` is a git repo is operator-determined (today it isn't a repo in the worktree layout). Acceptance is best-effort on git.
5. **Persona-level skills, memory tuning, and eval harnessing** for Archie and Dev. The personas are **pre-claimed**, not fully **onboarded**.

### 3.3 Scope fallback

If Hermes integration stretches beyond the milestone budget, **Dev ships in M6.1**. Archie + the runbook's first draft still close M6. Execution order (§12) makes this fallback graceful — DeepAgents-first, Hermes-second.

## 4. Architecture

### 4.1 The coupling contract (six items)

The minimum surface an agent harness must satisfy to be a Team Room member:

1. **Lifecycle.** Either `session` (current pattern: per-turn spawn, idle timeout) or `persistent` (one long-lived container, auto-restart, no idle timeout). Declared in `agent.yaml`.
2. **Shim at container entrypoint.** Reads `{type:"wake", events:[...]}` JSON envelopes on stdin. On each wake, pokes the harness's programmatic API to process its inbox.
3. **Mail-MCP.** The harness's MCP client is configured against the daemon's mail-MCP server using the env vars already injected by `src/agent-spec/build-spec.ts` (`TEAMROOM_MCP_URL`, `TEAMROOM_MCP_TOKEN`).
4. **Codebase mount.** `/codebase` bind-mount is pointed at the harness's filesystem / shell working directory.
5. **Model routing through the proxy.** The shim translates Team Room's uniform env contract (`TEAMROOM_MODEL_BASE_URL`, `TEAMROOM_MODEL_API_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) into the harness's native model-config shape.
6. **Dockerfile.** Per-harness base image and dependencies, honoring the harness's own Docker guidance where one exists.

Every other substrate surface (identity resolution, observability tagging, credential minting, mail delivery, message threading) is team-harness-side and unchanged by this milestone.

### 4.2 Team-harness / agent-harness boundary

The daemon treats a container as opaque beyond the wake-envelope contract. It does not know or care whether the process inside is a Claude Code SDK, a LangGraph graph, a DeepAgents LangGraph graph, a Hermes `AIAgent` instance, or a Python script. The boundary is:

- **Host-side (team harness):** process lifecycle, mail routing, MCP serving, model proxying, observability, storage.
- **Container-side (agent harness):** wake handling, LLM invocation, tool calls (including back through mail-MCP), filesystem operations on `/codebase` and `/store`.

This is the property M6 validates. If we can plug in two independently-developed external harnesses without host-side rework beyond the small lifecycle addition in §5, the harness-agnostic thesis is honest.

## 5. Substrate changes

### 5.1 Lifecycle field

Add to `src/agent-config/agent-config.ts`:

```yaml
# agent.yaml
name: archie
provider: deepagents
model: <decided at plan time>
image_tag: teamroom-agent-archie:latest
lifecycle: persistent     # new; default `session`
```

Enum: `"session" | "persistent"`. Default: `"session"` (all existing agents unchanged — no migration of studio-assistant / claude-assistant / claude-researcher).

### 5.2 Session-manager branch on lifecycle

`session` behavior is unchanged: spawn per turn-or-session, idle timeout kills the container.

`persistent` behavior:

- Container spawns once at daemon boot (see §5.6 — compose-layer init).
- Stdin pipe kept open for the container's lifetime.
- No idle timeout (the per-agent idle-timeout backlog item is effectively folded in: `persistent` means "idle-timeout = ∞").
- On unexpected container exit, the session-manager's `onExit` handler fires and the manager respawns a fresh container (fresh MCP token, fresh DockerRunSpec). A short backoff (1s initial, doubling to a cap of 30s) prevents tight crash loops.
- On daemon shutdown (`SessionTimerManager.shutdown()` followed by `killAll()`), persistent containers are stopped cleanly and NOT respawned. A `isShuttingDown` flag gates the respawn path.

Location: `src/session-manager/session-manager.ts` grows two concepts — a `spawnIfAbsent(agentId)` method for boot-time spawning, and a `lifecycleFor: (agentId) => "session" | "persistent"` dep that `armTimer` and `removeSession` both consult.

### 5.3 Docker lifecycle flags — no change this milestone

No Docker `--restart` flag is added. The daemon is always watching via `RunningContainer.onExit`; daemon-managed respawn (§5.2) gives the "auto-restart" property without the `--rm` + `--restart` incompatibility and without the stdin-reattach problem Docker's `--restart` would introduce. Existing `docker run --rm -i` args work for both `session` and `persistent` lifecycles unchanged.

Revisit Docker-level restart policy only if daemon-watching proves insufficient (e.g., the daemon itself crashes frequently and persistent agents should survive its outages). That's a future-milestone concern.

### 5.4 Provider enum / shape

`agent-config.ts`'s provider enum extends from `anthropic | lm-studio | ollama` to include `deepagents | hermes`. If the extension reveals the enum is outgrowing its shape (N=5 approaches a legitimate abstraction), consolidating the providers is a judgment call at plan time. Default is enum extension; broader refactor is considered only if the code demands it.

### 5.5 Model-proxy extensions (conditional)

Proxy extensions are **not** budgeted as in-scope up-front. If the model chosen for either Archie or Dev requires a provider the proxy doesn't front today (Anthropic, LM Studio, Ollama), the plan captures the extension. If not, no change. A minor proxy touch — e.g., `OPENROUTER_BASE_URL` — is acceptable in-milestone; a new provider adapter class is a signal to pick a different model or defer.

## 6. Per-agent-harness deliverables

### 6.1 Archie (DeepAgents)

Path: `agents/archie/`.

| File | Purpose |
|---|---|
| `agent.yaml` | `name: archie`, `provider: deepagents`, `model: <plan>`, `image_tag: teamroom-agent-archie:latest`, `lifecycle: persistent`. |
| `Dockerfile` | Python base — highest version DeepAgents supports; target **3.13** unless DeepAgents docs indicate otherwise at plan time. Debian-slim over Alpine (MCP stdio child processes + `npx` need glibc). `COPY`s DeepAgents source from `vendor/deepagents/` (§6.3) and installs from source; adds `langchain-mcp-adapters` and a LangGraph checkpointer backend (SQLite). |
| `shim.py` | Container entrypoint. Reads stdin wake envelopes. On each wake: calls `create_deep_agent(tools=..., system_prompt=...).invoke({messages: [...]}, config={"configurable": {"thread_id": "<mail-thread>"}})` with a LangGraph SQLite checkpointer backing per-mail-thread persistence. Pipes text/errors to stderr. |
| `AGENTS.md` | Archie's persona (architect): voice, focus areas, what he notices, how he reports findings. **Pre-claimed persona, not fully onboarded** — voice content is minimum-viable, not the artifact that will eventually live here. |
| `store/.gitkeep` | Per-agent persistent scratch. Holds the LangGraph checkpointer DB plus any DeepAgents memory-store artifacts. |

**Mail-MCP wiring.** Python `langchain-mcp-adapters.MultiServerMCPClient` pointed at `TEAMROOM_MCP_URL` with `TEAMROOM_MCP_TOKEN` as the bearer. Discovered tools flow into `create_deep_agent(tools=[...mail_tools])`.

**Codebase.** DeepAgents's real-filesystem backend rooted at `/codebase` so `read_file` / `edit_file` operate directly on the mount. Shell via DeepAgents's `execute` tool is **deferred for M6** — it requires a sandbox backend per DeepAgents docs; the container itself is the sandbox we already have, but wiring that into DeepAgents' `execute` is out-of-scope for this milestone. The plan may introduce a minimal shell adapter if Archie's acceptance requires it; otherwise shell is left off M6.

### 6.2 Dev (Hermes)

Path: `agents/dev/`.

| File | Purpose |
|---|---|
| `agent.yaml` | `name: dev`, `provider: hermes`, `model: <plan>`, `image_tag: teamroom-agent-dev:latest`, `lifecycle: persistent`. |
| `Dockerfile` | Builds from the vendored Hermes source at `vendor/hermes-agent/` (§6.3) — either extending the upstream Dockerfile (Debian 13.4, Python 3.13, Playwright, Chromium, ripgrep, ffmpeg, non-root `hermes` user) or building fresh from source. Choice is a plan-time call (§14). Adds our `shim.py` and any MCP-client-side Python deps not already bundled by Hermes. |
| `shim.py` | Container entrypoint. Reads stdin wake envelopes. Embeds `AIAgent` directly (`from run_agent import AIAgent`), pushes each wake as a conversation tick. Source read during plan to confirm API shape; fallback is Hermes's ACP stdio adapter with a separate JSON-RPC pipe. |
| `config.yaml` | Preseeded `~/.hermes/config.yaml` with `mcp_servers.teamroom_mail` (HTTP transport, pointed at `TEAMROOM_MCP_URL`, bearer `TEAMROOM_MCP_TOKEN`), `terminal.backend: local`, `terminal.cwd: /codebase`, and `model.provider` routed to the Team Room proxy. |
| `SOUL.md` | Dev's persona (developer): voice, focus areas, code-quality stance. **Pre-claimed persona, not fully onboarded.** Hermes's slot-1 system-prompt file. |
| `AGENTS.md` | Human-facing description (matches our existing per-agent convention). |
| `store/.gitkeep` | Per-agent persistent scratch: `~/.hermes/` state, session history, memories, skills. |

**Mail-MCP wiring.** Hermes's native `mcp_servers:` config block (HTTP). No wrapper; the seven mail tools are namespaced by Hermes as `mcp_teamroom_mail_mail_*`.

**Codebase.** `terminal.backend: local`, `terminal.cwd: /codebase`. The Hermes `terminal.backend: docker` option is explicitly NOT used — Dev is already inside the Team Room container; nesting a Docker-backed terminal inside would be path-translation hell and defeats the purpose of the single mount.

**Cold-start.** Hermes's image is heavy (Playwright + Chromium + ffmpeg). Persistent lifecycle amortizes this across the daemon's uptime, making the boot cost a one-time hit per daemon start — exactly the case the `persistent` lifecycle is designed for.

### 6.3 Source tracking (shared across both agents)

Both harnesses are vendored as **git submodules** at `vendor/<harness>/`, tracked directly against their upstream repositories. No forks — we revisit if a concrete need to diverge arrives.

**Layout:**

```
vendor/
├── deepagents/        ← submodule → github.com/langchain-ai/deepagents
└── hermes-agent/      ← submodule → github.com/NousResearch/hermes-agent
```

**Dockerfile pattern.** Each agent's Dockerfile `COPY`s its harness source from the corresponding vendored path and installs from source. Reproducibility comes from the submodule's pinned SHA, not from external package-version resolution.

**Why submodules over published packages.** Three reasons:

1. **Browseability during plan execution.** §14 explicitly calls for reading Hermes's `run_agent.py` to confirm the `AIAgent` library-embed shape; having it under `vendor/hermes-agent/` makes grep / IDE navigation native to this repo.
2. **Reproducibility + offline-tolerant builds.** Submodule SHA pins exact source; Dockerfile `COPY` doesn't require network at build time.
3. **Asymmetry between harnesses.** DeepAgents has a clean PyPI story; Hermes's install path is a `curl | bash` script. Submodules normalize the two so the runbook has one rule.

**Bump workflow.** Intentionally manual and explicit:

```bash
cd vendor/<harness>
git fetch
git checkout <tag-or-sha>
cd ../..
git add vendor/<harness>
git commit -m "chore(vendor): bump <harness> to <tag>"
```

Each bump is its own commit, surfacing intent (bug-fix vs minor feature vs breaking change) and making rollback trivial. Cadence is owner-driven, not automatic.

**Onboarding friction.** First-time contributors need one extra step:

```bash
git submodule update --init --recursive    # or: git clone --recurse-submodules ...
```

`README.md` gets a note. The new `docs/runbooks/onboarding-an-agent-harness.md` covers the submodule pattern as part of the six-item contract (either as a new item or folded into the Dockerfile item — plan-time call).

**Switching to a fork later.** If we identify a need to diverge, the switch is a single-line remote change (`git remote set-url origin <fork-url>`) and a new push. No re-architect. Deferred until the need arrives.

**Reflection loop.** Submodules are not the user's normal working style — adopted here because they fit this scenario (external harnesses we want pinned, browseable, and bump-controlled). Friction gets captured via the tabled-items workflow (§9.3) and reflected on at M6 retro; we may discover a better pattern and switch in a later milestone.

**Future harnesses.** This layout also answers the next-harness question (roadmap backlog: "Subsequent harness additions are individual mini-milestones"): each new harness adds its own `vendor/<name>/` submodule following the same pattern.

## 7. Model credential routing

**Default.** Both agents route through the daemon proxy. Env vars already injected by `src/agent-spec/build-spec.ts` — `TEAMROOM_MODEL_BASE_URL`, `TEAMROOM_MODEL_API_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` — are consumed by the shims.

**Per-harness translation.** Model-config shape differs between harnesses, so the shim is the translation boundary:

- **DeepAgents** takes a LangChain model instance (`ChatOpenAI`, `ChatAnthropic`, etc.). The shim constructs it pointed at the proxy URL with the proxy token.
- **Hermes** takes a `model:` block in `config.yaml`. The shim populates `provider: custom`, `base_url: <proxy URL>`, `api_key: <proxy token>` (or `provider: anthropic` + `base_url: <proxy URL>` for the Anthropic OAuth path).

**The shim is where the translation lives.** This spec makes the boundary explicit so future readers know where to look when a new harness adds a third translation.

**Fallback.** If an agent needs a provider the proxy doesn't front, two options in order of preference: (a) extend the proxy in-milestone; (b) inject native provider credentials directly into the container, bypassing the proxy for that agent. Expectation is (a). Option (b) is an acknowledged compromise that would be documented in the plan if taken.

## 8. Invocation model

The existing `{type:"wake", events:[...]}` stdin protocol is the wake mechanism for both new agents, unchanged from M1's design. What changes is the **container lifecycle** (§5.2): the container runs for the daemon's lifetime, the stdin pipe stays open, wake envelopes flow in as mail arrives.

The daemon does not gain a new notification surface. `session-management`'s mail-delivery path already writes wake envelopes to the relevant container's stdin; a persistent container receives them exactly the same way a session container would. This is the single most important property for minimising daemon-side change in M6.

Hermes's own `cronjob` tool is inherited as a capability but **not used** for mail checking. Future subscription- or schedule-driven work can revisit.

## 9. Onboarding-an-agent-harness runbook

### 9.1 Scope of the runbook

`docs/runbooks/onboarding-an-agent-harness.md` — new artifact.

Covers the six-item coupling contract (§4.1). **Procedure form, not skill** — the work is discoveryful per harness (vendor docs, GitHub source reading, user input, research) rather than a tight tactical repeat. Skill form becomes appropriate later, once we have N=3+ integrations and the pattern is stable enough to codify.

Per-harness appendix: **Archie / DeepAgents** and **Dev / Hermes**, each capturing the specific choices and gotchas that surfaced during their integration.

### 9.2 Explicitly NOT covered

`docs/runbooks/agent-onboarding.md` (preserved, untouched) remains the home for the future agent-instance-onboarding work: identity, purpose, responsibilities, not-to-do's, skills, context, memory. The new runbook opens with a section distinguishing the two — agent-harness onboarding is about *provisioning*; agent onboarding is about *mission*.

### 9.3 Drafting workflow

1. Substrate changes land (§5).
2. Archie integration happens; as we learn, we table notes into `docs/tabled.md` under a dedicated "for onboarding-an-agent-harness.md" section.
3. First draft of the runbook is written from the Archie experience.
4. Dev integration happens; the draft runbook is consulted and refined where it falls short. New tabled items roll in.
5. Runbook consolidated near milestone close.

The shape of the runbook is **expected to shift during plan writing and implementation.** This is the first time we have done this; the up-front design captured here will be wrong in ways we cannot see yet, and the tabled-items workflow is how we correct it.

## 10. Naming and personas

M6 **pre-claims** two personas from the roadmap backlog:

- **Archie** — architect. Listed in the roadmap with DeepAgents flagged as a likely harness. Voice and focus are stubbed in `agents/archie/AGENTS.md`.
- **Dev** — developer. Voice and focus stubbed in `agents/dev/AGENTS.md` + `agents/dev/SOUL.md`.

Both are **not fully onboarded** — skills/context/memory work remains future, alongside whatever persona-aware eval infrastructure (M9) reaches maturity. The current voice/focus content is minimum-viable-persona; the real artifact that will eventually live there is a separate future build.

**Memory differs by harness.** Dev (Hermes) ships a rich persistent memory (SQLite + FTS5 + on-disk `memories/` + `skills/`). Archie (DeepAgents) supports LangGraph Memory Store opt-in via the checkpointer. Our existing internal-harness agents have no memory at all. Memory optimisation and per-agent memory effectiveness evaluation is future work — relevant when M7 memory and M9 evals land.

**Subagents.** Both DeepAgents and Hermes support spawning subagents internally. When a future persona (say, Pam the PM) is mapped onto one of these harnesses, the subagent metaphor composes: "Pam has people working for her" without Team Room owning the subagent model. Noted as emerging design space, not a deliverable.

## 11. Acceptance

Manual scenarios, run live at milestone close against real LM Studio / Anthropic per each agent's model choice.

### S1 — Archie participates in mail + codebase

- `claude-assistant` (or `claude-researcher`) sends a mail to `archie` asking about a codebase detail.
- Archie reads the mail, reads relevant files under `/codebase`, replies in-thread with findings.
- Full mail round-trip visible in `teamroom thread`.

### S2 — Dev participates in mail + codebase

- Same shape as S1, with Dev as the recipient.
- Dev reads the mail, reads/edits a file under `/codebase`, replies in-thread.

### S3 — Cross-harness peer communication

- Archie and Dev exchange mail with each other (either direction), at least one round-trip.
- Demonstrates that the substrate is harness-agnostic end-to-end.

### S4 — Persistent-container resilience

- `teamroom serve` restarts cleanly. Both persistent containers come back up and are reachable via mail after restart.
- If a harness crashes mid-acceptance, the session-manager's `onExit` handler respawns the container (§5.2) and mail continues flowing.

### Git — best-effort, not gated

Both harnesses ship shell + git in their images. Whether `/codebase` is a git repo is operator-determined. In today's worktree layout the mount isn't a repo; a real deployment will be. Acceptance does not require git-state verification. The runbook documents "git works when the mount is a repo; doesn't when it isn't." Codebase-as-first-class-git-workspace is a separate backlog item.

## 12. Execution order

1. **Substrate changes (§5).** Small, shared; one PR-sized batch. Lifecycle field + session-manager branch (daemon-managed respawn) + provider-enum extension.
2. **Archie integration (§6.1).** Lower-risk first: LangChain-ecosystem, closest to studio-assistant's plumbing.
3. **First draft of the runbook (§9).** Written from the Archie experience; tabled items folded in.
4. **Dev integration (§6.2).** Stresses the runbook; refines it where it falls short.
5. **Runbook consolidation.** Both appendices, generalized six-item contract, note distinguishing from `agent-onboarding.md`.
6. **Manual acceptance (§11).**

Scope fallback (§3.3): if Dev is looking like it will not fit the milestone budget, M6 ships Archie + runbook-v1; Dev → M6.1. The DeepAgents-first order makes this clean.

## 13. Pre-M6 verification (tabled)

From `docs/tabled.md`:

> Verify studio-assistant ↔ claude-assistant mail round-trip end-to-end.

Clarifies that current-team peer communication works before we add new peers. Either a pre-plan manual check or the first task of the M6 plan's prep phase.

## 14. Open questions for plan time

Deliberately deferred from spec to plan — each is small, empirical, and easier to answer once we are in the code:

1. **Specific model choice per agent.** Anthropic (routed through the proxy) or a local OpenAI-compat? Drives the proxy-extension decision (§5.5) and decides whether Hermes's ≥64k context requirement pushes us to a particular model.
2. **Python version per harness.** Confirm DeepAgents' highest supported Python (target 3.13). Hermes follows its own Dockerfile (Python 3.13, already pinned upstream).
3. **Hermes `AIAgent` library-embed API shape.** Read `run_agent.py` source; confirm the shim pattern. Fallback: ACP stdio adapter.
4. **Provider enum extension vs broader refactor.** Inspect the code; decide.
5. **Whether to add a minimal shell adapter for Archie.** Needed only if S1 requires shell/git for Archie specifically; otherwise DeepAgents FS tools suffice for M6.
6. **Session-manager branch shape.** Concrete second session strategy or flag inside the existing one. Code-inspection call during planning.
7. **Exact install commands per harness** (§6.3). `pip install .`, `pip install -e .`, `pip install /path/`, or harness-specific (e.g., Hermes's `uv`-based install). Driven by what each harness's own packaging supports.
8. **Dev image — extend upstream Dockerfile or build fresh from source?** Extending inherits Nous's non-root user, `/opt/data` volume, `ENTRYPOINT` conventions. Building fresh from `vendor/hermes-agent/` is cleaner but duplicates their setup work. Decision at plan time after inspecting the upstream Dockerfile.

## 15. Related

- **Predecessor as-built:** [M5 LangGraph runtime](../as-built/2026-04-22-teamroom-m5.md) — established the in-container MCP client pattern reused here.
- **Roadmap:** [M6 row](../roadmap.md) — original framing; this spec narrows and executes on it. Backlog §Agent personas and multi-harness is the lineage of the persona concept; §Operability contains items we may touch.
- **Runbooks:**
  - [`agent-onboarding.md`](../runbooks/agent-onboarding.md) — preserved, future work.
  - New: `onboarding-an-agent-harness.md` — this milestone's deliverable.
- **Tabled:** [`tabled.md`](../tabled.md) — pre-M6 verification note.
- **Team Room context:** [`team-room-context.md`](../../team-room-context.md) — §2 motivation, §5 design principles. The frozen original vision this spec pivots from.
- **Memory entries likely to be load-bearing during M6:**
  - `project_teamroom_langgraph_direction` — LangGraph is now the present shape for the OpenAI-compat branch; DeepAgents inherits its plumbing.
  - `feedback_teamroom_protocol_sdk_default` — reinforced by this milestone: both harnesses supply reference MCP clients; we use them as-shipped.
  - `feedback_teamroom_see_only_as_far_as_needed` — the lifecycle field is N=2 (session + persistent), earning its consolidation.
  - `feedback_teamroom_minimize_process_deps` — persistent containers are the long-running shared dep; the design confines them to one per agent, per daemon lifetime, no host-side extra service.
