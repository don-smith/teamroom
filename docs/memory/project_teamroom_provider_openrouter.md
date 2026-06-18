---
name: Team Room — OpenRouter is the sole provider backbone
description: All agents route through OpenRouter as the single model provider; LM Studio, Ollama, OpenAI, and Anthropic direct-access providers have been removed
type: project
---

Team Room's model-provider backbone is **OpenRouter only**. The provider was narrowed to `"openrouter"` during the persona realignment milestone. All four agents (Archie, Doc, Libby, Micah) route through OpenRouter using `deepseek/deepseek-v4-flash`.

The model proxy (`src/modules/model-proxy/model-proxy.ts`) composes only the OpenRouter adapter. LM Studio, Ollama, OpenAI, and Anthropic adapters have been removed along with their tests, OAuth caches, and credential flows.

**How to apply:**
- `agent.yaml` for new agents must set `provider: openrouter`
- Do not add new provider adapters without a concrete need and documented blocker — the single-provider shape is intentional
- If a future persona needs a different model, use OpenRouter's model routing rather than adding a new direct provider