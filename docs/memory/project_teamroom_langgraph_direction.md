---
name: Team Room — LangGraph is the intended per-agent runtime framework
description: Intended direction is LangGraph inside each agent container for per-agent agency, reasoning graphs, and state; M1 uses a minimal runtime but the container contract is designed to accommodate LangGraph later
type: project
originSessionId: 2b248c3a-2db2-43f8-bcf5-b41c02065a20
---
Intended direction for Team Room: each agent runs a LangGraph workflow inside its container. Each agent has its own agency, reasoning graph, state, and process. For M1 the agent-runtime is intentionally simple (direct LLM invocation is acceptable), but the container contract is designed to be language-agnostic and runtime-opaque so LangGraph slots in later without daemon-side changes.

**Why:** User stated 2026-04-18 during M1 brainstorming: "I'm going to lean toward LangGraph as the SDK for the individual agents so that they can each have their own agency and process... for M1 maybe we could just have something super simple that's just invokes the LLM but I think we're gonna need something much more robust than that for each of the agents eventually." LangGraph supports graph-based agent reasoning, checkpointing, and persistent state — aligned with Team Room's longer-term need for per-agent memory, reasoning, and delegation.

**How to apply:**
- Do not build LangGraph into the M1 agent-runtime. Keep it simple; ship the shape.
- Keep the container contract language-agnostic (stdin/stdout JSONL): LangGraph.js (Node) and Python LangGraph are both viable runtime choices per agent.
- Agent internals are the agent's concern. The daemon treats the container as opaque beyond the stdin/stdout envelope and the writable mount. This enables per-agent runtime divergence (different agents could even use different frameworks).
- LangGraph checkpoint/state persistence belongs inside the agent's writable mount (`/store`), not a daemon-level concern.
- When designing shared substrate (event bus, memory, scheduling), evaluate whether it plays well with LangGraph's state/checkpointing model.
