---
name: Team Room — prefer OpenAI/Codex and LM Studio for non-Claude agents
description: The user's current model budget/preference has shifted away from Anthropic for most Team Room agents; use OpenAI/Codex or LM Studio where practical, reserving Anthropic primarily for Claude-specific agents.
type: project
---

Team Room's model-provider preference has shifted toward **OpenRouter as the provider backbone** for most agents, using various models through it (e.g. `deepseek/deepseek-v4-flash` for Archie). Reason: during M6, live Archie acceptance with OpenRouter/DeepSeek proved reliable, and the user wants to consolidate providers rather than spread across OpenAI, LM Studio, Ollama, and OpenRouter separately. Consolidation is tabled for pre-M7 cleanup (see `docs/tabled.md`).

Historical preference (still valid until consolidation is acted on): for non-Claude agents, prefer OpenAI/Codex or local LM Studio where practical. Anthropic remains important for Claude-specific agents and OAuth flows.

Anthropic remains important for Claude-specific agents and Claude Code/OAuth flows, but it is no longer the preferred default for every architect/researcher-style Team Room agent. When adding or tuning agents, treat provider choice as an explicit operational decision: local LM Studio for cheap/fast experimentation, OpenAI/Codex for higher-capacity hosted work, Anthropic where the Claude runtime/Claude-specific behavior is the point.

Why: while reviving M6, live Archie acceptance was blocked by Anthropic 429s and OpenRouter 401s. The user clarified that their subscription mix has changed since the earlier Anthropic-centered design and asked to switch Archie to LM Studio first, likely OpenAI/Codex later.

How to apply:
- Do not assume `provider: anthropic` for new non-Claude agents.
- Preserve runtime/provider separation: an agent can keep a specialized runtime such as `deepagents` while changing its model provider to `lm-studio` or `openai`.
- For Anthropic-specific setup questions, the OAuth-via-Claude-Code details remain relevant, but they should not be treated as the universal Team Room default.
- Expect future work around per-agent fallback models and mixed provider routing (LM Studio, OpenAI/Codex, OpenRouter, Anthropic) rather than a single global provider choice.
