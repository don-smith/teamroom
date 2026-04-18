# Team Room — Context Handoff

*Snapshot of brainstorming conversation on 2026-04-18. Port this into the new Team Room repo and resume from "Next step" at the bottom.*

---

## 1. Vision

**Team Room** is a multi-agent harness modeled after a software delivery team. Instead of one assistant, you run a team of cooperating agents — each with its own identity, storage, memory, and tools, able to share a codebase, communicate with each other, subscribe to team events, and be scheduled independently.

The mental model is deliberate: not "a bigger agent" but "a team of colleagues" — each narrow, each specialized, each accountable for its own work, coordinating through explicit team infrastructure rather than implicit shared state.

## 2. Motivation

The user has been running **NanoClaw** (a single-agent-per-chat harness at `/Users/don/projects/nanoclaw`) and has lived experience with what works and what doesn't. Named agents (Corsa, Sid, Brian, Paula) are each isolated containers — good — but NanoClaw has no first-class concept of them being a *team*. Agents can invoke each other via IPC and share a `store/` directory, but there's no event bus, no shared messaging, no team-level observability, no per-agent evaluation, no multi-model routing.

Team Room is an opportunity to keep the patterns that worked in NanoClaw and redesign the parts that didn't.

## 3. NanoClaw Reference Architecture

Worth understanding because Team Room borrows heavily from it. Full exploration in the source conversation.

**Summary:** Single Node.js daemon (`src/index.ts`) keeps channel connections (WhatsApp, Telegram, Slack, etc.) open, polls SQLite for new inbound messages, spawns a fresh sandboxed container per agent turn running the Claude Agent SDK. Agents talk back to the daemon via JSON files dropped into `data/ipc/<folder>/` directories. Each agent identity = one chat JID = one folder under `groups/` = one CLAUDE.md = one Claude session.

**Key components:**

- **Orchestrator** — purely procedural (no LLM in the hot path). All intelligence lives in containers.
- **Channels** — self-registering plugins implementing a `Channel` interface (`connect`, `sendMessage`, `ownsJid`, optional `setTyping` / `sendVoice` / `syncGroups`).
- **SQLite** — in-process, not a separate server. Stores messages, chats, registered groups, sessions, tasks, router state. Watermark + cursor pattern for crash-safety.
- **Container runner** — spawns a container per turn, mounts per-group folder writable + project root read-only (main only). Session IDs persist on disk so fresh containers resume prior Claude sessions.
- **GroupQueue** — in-memory per-group serialization; holds stdin handles for "keep container alive between messages" pattern.
- **IPC watcher** — polls JSON envelopes, authenticates by source directory, routes to handlers (`invoke_agent`, `schedule_task`, `register_group`, etc.).
- **Credential proxy** — local HTTP server on localhost. Containers route Anthropic API calls through it. Keys never touch container env.
- **Process lifecycle** — launchd (`KeepAlive=true`) on macOS, systemd on Linux. No internal watchdog; OS is the watchdog.

**Patterns worth stealing for Team Room:**
- Procedural orchestrator + LLM-only-in-containers
- DB as the integration bus between channels and agents
- Per-agent filesystem isolation; fresh container per turn
- Stdin-piped prompts, stdout-streamed results
- File-based IPC back from agents (atomic, inspectable)
- Credential proxy instead of env injection
- Sessions by folder, not by process

**What NanoClaw does *not* have (and Team Room needs):**
- Typed shared state with conflict policy (only an untyped `store/` dir)
- Agent registry with explicit tool/permission scope
- Event bus / pub-sub between agents
- Inter-agent messaging as a first-class primitive
- Per-agent evaluations
- Cross-agent tracing / team-level observability
- Multi-model routing
- Dedicated per-agent memory system
- Self-improvement / team-ceremony primitives

## 4. Multi-Agent Harness Research Summary

Survey conducted against AutoGen/AG2, CrewAI, LangGraph, OpenAI Agents SDK, MetaGPT, ChatDev, CAMEL, Magentic-One, Claude Code subagents, Letta/MemGPT, smolagents.

### Collaboration topologies
- **Orchestrator–worker** (Anthropic Research, LangGraph supervisor) — one lead plans, workers execute, lead synthesizes. Wins on breadth-first parallelizable tasks (Anthropic: +90.2% vs single-agent Opus 4 on their research eval, at ~15× token cost).
- **Group chat** (AutoGen) — all agents see one transcript, speaker-selection picks next. Fun but explodes past 4–5 agents.
- **Handoff** (OpenAI Swarm) — one active agent at a time; `transfer_to_*` tool calls. Good for routing, bad for parallelism.
- **Pipeline** (MetaGPT) — PM → Architect → Engineer → QA via typed artifacts. Wins when SOP is well-understood; brittle when upstream errs.
- **Blackboard** — agents read shared board, controller picks next. Flexible, needs good controller.
- **Debate** (Du et al.) — measurable factuality gains, usually loses to Self-Consistency at matched token budget.

### The honest finding on "does multi-agent help?"
**Anthropic's Research team** says yes for breadth-first parallel work. **Cognition ("Don't Build Multi-Agents")** says no for coding — two sub-agents writing into a shared codebase without shared context produce incompatible work (the Flappy Bird example: one makes a Mario background, the other makes an unrelated bird). **OpenAI's practical guide** recommends starting single-agent, splitting only when prompt bloat, diverging instructions, or security boundaries force it.

### Most valuable multi-agent pattern in practice
**Critic/reviewer loops.** Producer + independent reviewer with different tool access (or different model). Appears in MetaGPT's QA, ChatDev's Reviewer, Anthropic's CitationAgent. Cheap quality lift.

### What to steal for Team Room
1. **Typed shared state with a reducer** (LangGraph model) or **append-only memory blocks** (Letta model) — not raw transcript sharing.
2. **Explicit agent registry with tool/permission scoping** — partition by permission boundary, not by "role narrative."
3. **Cross-agent tracing** — Anthropic tracks decision patterns and interaction structures without logging message contents.
4. **Critic/reviewer as the first multi-agent pattern** — cheapest quality win.
5. **Per-agent token/tool-call/wall-clock budgets** — one runaway subagent can burn a month's quota.

### What to avoid
- Group chat with auto speaker selection — hard to debug, explodes past 4–5 agents
- Debate rounds — pay heavily to usually tie Self-Consistency
- Deep hierarchies — every hop loses information via summarization
- Letting multiple agents mutate the same string without a reducer

### Reading list (ordered)
1. Anthropic — [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
2. Cognition — [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) (HN discussion: https://news.ycombinator.com/item?id=45096962)
3. OpenAI — [A Practical Guide to Building Agents (PDF)](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)
4. LangChain — [How and when to build multi-agent systems](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems)
5. Microsoft Research — [Magentic-One paper (arXiv 2411.04468)](https://arxiv.org/abs/2411.04468)
6. Letta — [Multi-Agent Shared Memory docs](https://docs.letta.com/guides/agents/multi-agent-shared-memory)
7. MetaGPT paper (arXiv 2308.00352); CAMEL paper (arXiv 2303.17760); Du et al. Multiagent Debate (arXiv 2305.14325); LbMAS Blackboard (arXiv 2510.01285)

## 5. Design Principles for Team Room

1. **Orchestrator stays procedural.** No LLM in the routing hot path. Deterministic and debuggable.
2. **Agents run in isolated containers.** Fresh per turn, stdin/stdout I/O, borrowed directly from NanoClaw.
3. **Per-agent isolation by default.** Own filesystem folder, own memory namespace, own tool config, own credentials.
4. **Shared resources are explicit and typed.** Shared filesystem (codebase + worktrees), event bus, inter-agent messaging — each a first-class primitive with a declared schema, not an untyped folder.
5. **Observability is not a milestone — it's a slice of every milestone.** Each subsystem ships with logs, metrics, and traces from day one.
6. **Permission scoping at the credential layer.** The proxy enforces "agent X can call model Y" and "agent X has OAuth scope Z." Not defense-in-depth — defense-at-the-boundary.
7. **Multi-model from the start.** Agents choose a model per turn, proxy resolves to provider/keys.
8. **Evaluations are per-agent.** Each agent has its own scenarios, criteria, and regression suite. Team-level evals compose from agent-level.
9. **Self-learning is bounded.** Agents can propose changes; changes are applied explicitly with outcome tracking. No silent self-modification.
10. **Team ceremonies are messages, not magic.** A retrospective is a structured message sent to the team topic. No hidden coordination layer.

## 6. Subsystem Inventory (14)

Flagged during scope assessment — this is what made the project too big for one spec:

1. Process/container runtime for agents
2. Per-agent storage (filesystem)
3. Per-agent memory (mem0 or similar)
4. Per-agent tools with permission scoping
5. Shared filesystem (code + worktrees)
6. Shared event store with pub/sub
7. Inter-agent messaging
8. External channels (WhatsApp/Telegram/etc.)
9. Scheduling / cron (agent- and orchestrator-initiated)
10. Database
11. Credential proxy with multi-model routing
12. Evaluations framework
13. Observability (agent + team level) *— cross-cutting, embedded in each milestone*
14. Self-learning + team ceremonies

## 7. Milestone Roadmap

Build order, with observability sliced into each milestone.

### M1 — "One agent that works"
Skeleton. Orchestrator process, SQLite, container runtime, agent registry, channel I/O (at minimum one channel — Telegram suggested), stdin/stdout piping, onboarding flow for new agent. Single agent, single hardcoded model.
**Observability slice:** structured logs, end-to-end trace for one agent turn, basic health endpoints.
**Exit criteria:** message in → agent responds → message out; new agent can be registered via CLI.

### M2 — "Multi-model credential proxy"
Local HTTP proxy. Per-agent model allowlists. Agent declares model in request; proxy resolves to provider + keys. Drop-in replacement for M1's hardcoded key.
**Observability slice:** per-agent + per-model token/cost metrics, API call traces with correlation IDs, rate-limit and error surfaces.
**Exit criteria:** same agent from M1 can use Claude, GPT, or Gemini by asking; all three flow through the proxy; cost attributed per agent.

### M3 — "Team substrate"
The thesis milestone. Event store (append-only, subscribable), inter-agent messaging primitive, shared filesystem mount (codebase + worktrees), permission model for who can read/write which topics and paths.
**Observability slice:** event bus inspection tooling, cross-agent trace propagation, who-read-what audit log.
**Exit criteria:** Agent A publishes event, Agent B subscribed to topic receives it and replies via messaging; both agents can see the shared codebase; a third agent denied access to a topic is actually denied.

### M4 — "Per-agent memory"
Pick mem0 or alternative. Namespace per agent. Decide memory shape (episodic, semantic, procedural). Tool surface so agent can write/read its own memory. Memory is *not* shared across agents — cross-agent "knowledge" flows through the event store from M3.
**Observability slice:** memory read/write events, retrieval relevance signals, memory size ceilings and eviction events.
**Exit criteria:** agent remembers across sessions; memory retrieval latency under target; memory usage bounded.

### M5 — "Scheduling"
Cron, agent-initiated scheduling (agent asks "wake me Tuesday"), orchestrator-initiated scheduling (human configures "daily stand-up at 9am"), wakeup events propagated through the M3 event store.
**Observability slice:** task lifecycle events, missed/late/stuck run detection, per-task duration distributions.
**Exit criteria:** agent schedules a future self-invocation; another agent subscribes to the wakeup event and participates; missed runs are surfaced.

### M6 — "Evaluations"
Per-agent eval harness. Scenarios (named test cases with expected behaviors), criteria (pass/fail + scored), regression suite. Team-level evals compose agent-level.
**Observability slice:** eval results over time, regression tracking on every change, per-commit eval deltas.
**Exit criteria:** every registered agent has at least one scenario; evals run on demand and nightly; regressions block deploy.

### M7 — "Team ceremonies + self-learning"
Retrospectives as structured messages, self-improvement loops where agents propose changes to their own config/prompts/tools, explicit application with outcome tracking.
**Observability slice:** what changes were applied, by whom, with what effect on eval scores from M6.
**Exit criteria:** agent proposes a prompt tweak, change is applied under feature flag, M6 evals run, outcome attributed back to the proposal.

## 8. Open Design Questions

These came up but weren't resolved — they're the first things to dig into when brainstorming M1.

- **Language / runtime.** Node.js (like NanoClaw) for consistency? Or reconsider (Go? Rust? Python)?
- **Container runtime.** Docker, Apple Container, Podman — start with which?
- **Database.** SQLite (NanoClaw) enough, or start with Postgres given multi-agent write volume?
- **Event store implementation.** SQLite append-only table? Postgres LISTEN/NOTIFY? Redis streams? NATS?
- **Channel protocol.** Adopt NanoClaw's `Channel` interface as-is or redesign?
- **Onboarding UX.** Interactive CLI, config file, web UI?
- **First channel to support.** Telegram (easiest — bot token, good API), WhatsApp (what Don uses today), or something terminal-only to start?
- **Starting team composition.** How many agents at M1 exit? Just one? Two + a messaging test?
- **Naming.** "Agent" vs "teammate" vs "colleague" in the API and docs. (Note: user explicitly disliked NanoClaw's "group" terminology for a single agent.)

## 9. Next Step When You Resume

Inside the new Team Room repo, start a new session and re-invoke the brainstorming skill on **Milestone 1**. Resume at "ask clarifying questions" — the first question should be about which of the open design questions in §8 matter most for M1.

Suggested opener to paste:

> I'm building Team Room (context in team-room-context.md). I want to brainstorm the design for Milestone 1: "One agent that works." Start by asking me about the open design questions most relevant to M1.

---

*End of capture document.*
