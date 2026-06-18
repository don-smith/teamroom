---
name: Team Room — DeepAgents and Pi are the primary agent runtimes
description: The two primary agent runtimes are DeepAgents (Python, filesystem+tools, persistent lifecycle) and Pi (TypeScript, coding agent SDK); LangGraph remains as a compatible runtime but is not the long-term direction
type: project
---

Team Room's two primary agent runtimes are **DeepAgents** and **Pi**, both routing through OpenRouter as the model provider backbone:

- **DeepAgents** — Python-based runtime for personas needing filesystem exploration, codebase reasoning, and persistent lifecycle. Archie (architect) is the first DeepAgents agent. Implemented in [`agents/archie/shim.py`](../../agents/archie/shim.py) with vendored source at `vendor/deepagents/`. Supports stdin-wake envelopes, SQLite checkpointing, MCP tool discovery, and lazy graph construction.

- **Pi** — TypeScript-based runtime for coding agents. Uses the `@earendil-works/pi-coding-agent` SDK. Implements the `AgentWorker` interface in [`src/agent-runtime/pi-worker.ts`](../../src/agent-runtime/pi-worker.ts).

The container contract remains **language-agnostic and runtime-opaque** — each runtime is an implementation detail inside the container. The daemon treats containers as opaque beyond stdin wake envelopes and the model-proxy/mail-MCP surface.

**Historical context:** At M1, LangGraph was the intended per-agent runtime. The project has since adopted DeepAgents (a LangGraph-based framework) and Pi as the two primary runtimes. The standalone LangGraph worker (`src/agent-runtime/langgraph-worker.ts`) remains for backward compatibility but is targeted for removal in pre-M7 cleanup (see `docs/tabled.md`).

**How to apply:**
- New agents: prefer DeepAgents for filesystem/architecture personas, Pi for coding personas.
- The container contract (stdin/stdout JSONL, host.docker.internal proxy, writeable mounts) is the stable interface — runtimes are implementation details.
- Do not add new runtimes without a concrete persona need. The two-runtime model is intentional consolidation.