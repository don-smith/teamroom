# Anthropic auth — credential setup for Team Room

The `claude-assistant` agent talks to the real Anthropic API through the model proxy. Two credential modes are supported; the proxy picks one at startup.

## OAuth (preferred — uses Claude Code subscription)

If you've logged into Claude Code on this machine, Team Room will pick up the OAuth token automatically — **on macOS** from the system Keychain (service `Claude Code-credentials`); **on Linux/Windows** from `~/.claude/.credentials.json`. No `.env` change needed.

To verify: start the daemon (`teamroom serve`) and confirm the boot log shows `anthropicAdapterPresent: true`. If turns for `claude-assistant` immediately error with `missing_credential`, discovery failed — see Troubleshooting below.

### Generating an explicit OAuth token (recommended for any non-interactive use)

The most reliable way to get a value for `CLAUDE_CODE_OAUTH_TOKEN` is the Claude Code CLI itself:

```bash
claude setup-token
```

This walks you through browser OAuth authorization and prints a long-lived token (`sk-ant-oat01-...`, ~1-year validity) to stdout. Paste it into `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

When the env var is set, it overrides whatever's in the Keychain or the file fallback.

### macOS Keychain access — first-time prompt

The first time the daemon reads the Keychain entry, macOS may show an "Allow access" prompt for the `security` command-line tool. Click **Always Allow** to avoid being asked again. If you click Deny, the daemon falls through to the file fallback (which doesn't exist on macOS), then to `ANTHROPIC_API_KEY`, then to `null` (which fails fast for `provider:anthropic` agents). The simplest workaround is to set `CLAUDE_CODE_OAUTH_TOKEN` explicitly.

## API key (fallback, non-subscription)

Get an API key from `console.anthropic.com`. Add to `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

If both an API key and an OAuth credential are present, OAuth wins.

## Discovery order (canonical)

1. `CLAUDE_CODE_OAUTH_TOKEN` from `.env` → OAuth mode.
2. **macOS only**: macOS Keychain entry `Claude Code-credentials` → OAuth mode. The stored value may be either a raw `sk-ant-oat01-` token or a JSON blob; both shapes are accepted.
3. `~/.claude/.credentials.json` (parsed for `oauth_token` / `access_token` / `token`) → OAuth mode. Used on Linux/Windows where Claude Code stores credentials in a file.
4. `ANTHROPIC_API_KEY` from `.env` → API-key mode.
5. Otherwise the daemon starts but `provider:anthropic` agents fail fast with `missing_credential`.

## What the proxy does with these

- **API-key mode:** every request from the container has its `x-api-key` header replaced by the real `ANTHROPIC_API_KEY` before forwarding to `api.anthropic.com`.
- **OAuth mode:** the proxy performs a server-to-server OAuth exchange the first time an Anthropic agent runs (`POST /api/oauth/claude_cli/create_api_key` with `Authorization: Bearer <oauth-token>`), caches the resulting temp API key (keyed by OAuth token), and substitutes that on subsequent calls. The temp key is refreshed when it nears expiry or when Anthropic returns 401 (proxy retries the original call exactly once after the refresh). Containers never see real credentials in either mode.

The container is mode-agnostic — its `AnthropicLlmClient` always sends `x-api-key: <routing-token>` and never knows which substitution mode the proxy is running.

## Troubleshooting

- **`turn errored: missing_credential`** — the proxy didn't find an Anthropic credential at boot. On macOS check the Keychain has an entry (`security find-generic-password -s "Claude Code-credentials"` should print metadata). If it doesn't, run `claude setup-token` and paste the result into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. On Linux check `~/.claude/.credentials.json`.
- **macOS prompts for Keychain access on every daemon start.** Click **Always Allow** rather than Allow. If the prompt is dismissable / reproducible, set `CLAUDE_CODE_OAUTH_TOKEN` in `.env` to bypass the Keychain entirely.
- **Repeated 401 from Anthropic in OAuth mode** — your OAuth token may have expired or been revoked. Run `claude setup-token` for a fresh one and update `.env` (or re-login to Claude Code so the Keychain entry refreshes), then restart the daemon.
- **`oauth_exchange_403` or signed-request errors** — Anthropic may have gated programmatic exchange. See `docs/tabled.md` for the fallback (Claude Agent SDK in the container).
- **`oauth_exchange_no_key`** — the exchange returned 2xx but the response didn't contain a recognizable temp-key field. Check the `oauth.exchange.completed` span and the upstream response body.

## Related

- [`docs/runbooks/smoke-test.md`](smoke-test.md) — exercises both backends end-to-end.
- [`.env.example`](../../.env.example) — credential placeholders.
- [`docs/specs/2026-04-18-m2-model-abstraction-design.md`](../specs/2026-04-18-m2-model-abstraction-design.md) — §3.5 (discovery), §6 (auth modes).
