---
name: Team Room — DeepAgents and Pi are the primary agent runtimes
description: The two primary agent runtimes are DeepAgents (Python, filesystem+tools, persistent lifecycle) and Pi (TypeScript, coding agent SDK); the container contract is language-agnostic and runtime-opaque
type: project
---

Team Room's two primary agent runtimes are **DeepAgents** and **Pi**, both routing through OpenRouter as the sole model provider:

- **DeepAgents** — Python-based runtime for personas needing filesystem exploration, codebase reasoning, and persistent lifecycle. Used by Archie (architect) and Libby (librarian). Implemented as `shim.py` files in `agents/archie/` and `agents/libby/` with vendored source at `vendor/deepagents/`. Supports stdin-wake envelopes, SQLite checkpointing, MCP tool discovery, and lazy graph construction.
- **Pi** — TypeScript-based runtime for coding agents. Uses the `@earendil-works/pi-coding-agent` SDK. Implements the `AgentWorker` interface in `src/agent-runtime/pi-worker.ts`. Used by Micah (coder) and Doc (health monitor).

The container contract is **language-agnostic and runtime-opaque** — each runtime is an implementation detail inside the container. The daemon treats containers as opaque beyond stdin wake envelopes and the model-proxy/mail-MCP surface.

**How to apply:**
- New agents: prefer DeepAgents for filesystem/architecture/knowledge personas, Pi for coding/testing personas.
- The container contract (stdin/stdout JSONL, host.docker.internal proxy, writable mounts) is the stable interface — runtimes are implementation details.
- Do not add new runtimes without a concrete persona need. The two-runtime model is intentional consolidation.