---
name: Team Room — NanoClaw is the design reference for container + credential patterns
description: When facing decisions about how Team Room handles agent containers, credential proxies, or Anthropic SDK integration, check qwibitai/nanoclaw on GitHub first — many of these are solved problems there. The credential-proxy + claude-agent-sdk pattern was lifted directly during M2's OAuth pivot.
type: project
---

[NanoClaw](https://github.com/qwibitai/nanoclaw) is a comparable open-source project that runs Anthropic-powered agents in containers using a credential-proxy pattern very similar to Team Room's M2 design. When facing architecture decisions in this space, check NanoClaw's source first — many problems we'd otherwise re-derive are already solved there.

**Why:** During M2 we burned multiple iteration cycles trying to get OAuth tokens to work directly against `/v1/messages` (eventually finding Anthropic gates that path). User pushback: "this is a solved problem because this is already working in nanoclaw. So we should just model it the same way." We then read NanoClaw's `container/agent-runner/src/index.ts` and saw the canonical pattern: spawn the Claude Code CLI inside the container via `@anthropic-ai/claude-agent-sdk`, point its `ANTHROPIC_BASE_URL` at the host's credential proxy, let the proxy substitute auth before forwarding upstream. M2 ships with that exact architecture (commit `973e5c4`).

**How to apply:**
- Before designing any new container-runtime / credential-injection / Anthropic-SDK feature, check `qwibitai/nanoclaw` for a reference implementation.
- Particularly relevant files: `container/Dockerfile` (how to install Claude Code CLI in the container image), `container/agent-runner/src/index.ts` (how to invoke `query()` from the SDK), the comment "Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL" (load-bearing — that's the architectural pivot M2 made).
- NanoClaw is MIT-licensed and uses similar conventions (TypeScript, Node 22, container-per-turn). Reading it is fair game for design inspiration, not just troubleshooting.
- This doesn't mean copy-paste — Team Room has its own M-line milestones and architectural choices (e.g., LangGraph direction, span-shaped logs). But the *pattern* of "stateless container + stateful CLI subprocess + host-side proxy for credentials + auth header swap" is the right starting point for any new agent runtime in Team Room.
