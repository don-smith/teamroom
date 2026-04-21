# `agent-config/` — host-side loader for per-agent folders

Exports `loadAgentConfig(agentDir)` which reads an agent's on-disk metadata (`agent.yaml`, `AGENTS.md`, `store/`), validates required fields, and returns a typed `AgentConfig` record the daemon uses to decide what to mount and which env vars to pass when spawning the container.

**Host-only.** This module runs in the daemon process only and is never copied into agent container images. The container reads its own configuration via environment variables (`TEAMROOM_MODEL`, `TEAMROOM_MODEL_BASE_URL`, `TEAMROOM_MODEL_API_TOKEN`) and files on its writable mount (`/AGENTS.md`, `/store/conversation.jsonl`) — the `AgentConfig` TypeScript type does not exist inside the container. This is the most important architectural boundary in M1; keeping this loader separate from [`agent-runtime/`](../agent-runtime/README.md) makes the boundary explicit in the folder layout.

## Files

- `agent-config.ts` — `loadAgentConfig(agentDir)`: validates folder shape + parses YAML (required fields: `name`, `model`, `image_tag`, `provider` ∈ {`anthropic`, `lm-studio`}) + returns typed config.
- `agent-config.test.ts` — co-located unit tests (valid load, missing files, missing YAML fields, provider validation).

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** `yaml` npm package; Node `fs`/`path`.
- **Used by:** [daemon/README.md](../daemon/README.md) (agent discovery at startup), [cli/send.ts](../cli/) (to resolve the target agent name).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §2 agent folder shape, §2 container contract (mounts/env).
