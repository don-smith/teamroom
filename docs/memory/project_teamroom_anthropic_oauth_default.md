---
name: Team Room — Anthropic auth defaults to OAuth via Claude Code subscription
description: OAuth via the user's Claude Pro/Max subscription is the default for provider:anthropic; API-key mode is fallback only — don't suggest it as default
type: project
---

For `provider: anthropic` agents in Team Room, OAuth via the user's Claude Pro/Max subscription is **the default and recommended path**, not a fallback. API-key mode (using `sk-ant-api03-*` keys from `console.anthropic.com`) exists only for users who can't or don't want to use a subscription.

**Implementation as of M2 (commit `973e5c4`):** the container uses `@anthropic-ai/claude-agent-sdk` which spawns the Claude Code CLI as a subprocess. The CLI honors `ANTHROPIC_BASE_URL` (pointing at the host's `LocalModelProxy`) and `ANTHROPIC_AUTH_TOKEN` (the per-turn routing token). The proxy substitutes the routing token for the real OAuth credential before forwarding to `api.anthropic.com`. The container never sees a real Anthropic credential.

**What we tried first and abandoned (don't relitigate):**
- M2 spec §6.2 originally described a server-to-server exchange against `POST /api/oauth/claude_cli/create_api_key` to trade a long-lived OAuth token for a short-lived temp API key. **Anthropic gates this endpoint** (returns 403 for tokens issued via `claude setup-token`).
- After that we tried sending `sk-ant-oat01-*` tokens directly to `/v1/messages` with `Authorization: Bearer + anthropic-beta: oauth-2025-04-20`. **Anthropic gates that path too** (returns 429 with NO `anthropic-ratelimit-*` or `retry-after` headers — that's gating, not real rate-limiting). The auth header shape is correct; the issue is account-tier scope.
- The `@anthropic-ai/claude-agent-sdk` subprocess path is the only known programmatic OAuth path for non-Claude-Code consumers. It works because the spawned CLI constructs requests with the full Claude Code identity (User-Agent, anthropic-beta flags) that Anthropic's gating layer expects. This matches NanoClaw's pattern (see `project_teamroom_nanoclaw_reference`).

**Why:** User has been explicit on this multiple times during M2 — "I've tried to be clear about this from the very beginning. I don't want to use API mode. I only want to use that as a fallback, but that's not the default for this implementation." The intent is for Team Room users to leverage their existing Claude subscription quota rather than pay separately metered API billing.

**How to apply:**
- When suggesting how to set up Anthropic credentials, default to "log into Claude Code (macOS Keychain auto-discovery) or run `claude setup-token` and paste into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`." Mention API-key mode only as a secondary option for non-subscription users.
- When designing new Anthropic-related features, assume OAuth-mode is the production path. API-key mode should still be supported (`discoverAnthropic` already handles it as the final fallback in the discovery chain) but isn't where new feature work should aim.
- Don't suggest "switch to API key" as a quick unblocker when an OAuth issue arises — fix the OAuth issue. (Doing so will be perceived as ignoring the user's stated preference, even if the API-key fallback works.)
- The `claude-agent-sdk` + Claude Code CLI subprocess pattern is load-bearing — don't try to "simplify" by going back to vanilla `@anthropic-ai/sdk` for the OAuth path; it doesn't work end-to-end.
