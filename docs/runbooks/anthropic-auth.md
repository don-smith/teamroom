# Anthropic auth — credential setup for Team Room

The `claude-assistant` agent talks to the real Anthropic API through the model proxy. Two credential modes are supported; the proxy picks one at startup.

## OAuth (preferred — uses Claude Code subscription)

If you've logged into Claude Code on this machine, the OAuth token is at `~/.claude/.credentials.json` and the proxy will pick it up automatically. No `.env` change needed.

To verify: start the daemon (`teamroom serve`) and look for a startup log line indicating the proxy started with `anthropicAdapterPresent: true`. If you see `agent.unhealthy` or turns marked errored with `missing_credential`, discovery failed.

To override the discovered location, set in `.env`:

```
CLAUDE_CODE_OAUTH_TOKEN=<the token value>
```

## API key (fallback, non-subscription)

Get an API key from `console.anthropic.com`. Add to `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

If both an API key and an OAuth credential are present, OAuth wins.

## Discovery order (canonical)

1. `CLAUDE_CODE_OAUTH_TOKEN` from `.env` → OAuth mode.
2. `~/.claude/.credentials.json` (parsed for `oauth_token` / `access_token` / `token`) → OAuth mode.
3. `ANTHROPIC_API_KEY` from `.env` → API-key mode.
4. Otherwise the daemon starts but `provider:anthropic` agents fail fast with `missing_credential`.

## What the proxy does with these

- **API-key mode:** every request from the container has its `x-api-key` header replaced by the real `ANTHROPIC_API_KEY` before forwarding to `api.anthropic.com`.
- **OAuth mode:** the proxy performs a server-to-server OAuth exchange the first time an Anthropic agent runs (`POST /api/oauth/claude_cli/create_api_key` with `Authorization: Bearer <oauth-token>`), caches the resulting temp API key (keyed by OAuth token), and substitutes that on subsequent calls. The temp key is refreshed when it nears expiry or when Anthropic returns 401 (proxy retries the original call exactly once after the refresh). Containers never see real credentials in either mode.

The container is mode-agnostic — its `AnthropicLlmClient` always sends `x-api-key: <routing-token>` and never knows which substitution mode the proxy is running.

## Troubleshooting

- **`turn errored: missing_credential`** — the proxy didn't find an Anthropic credential at boot; check `.env` and `~/.claude/.credentials.json`.
- **Repeated 401 from Anthropic in OAuth mode** — your Claude Code OAuth token may have expired or been revoked. Re-login to Claude Code (so a fresh token lands in `~/.claude/.credentials.json`) and restart the daemon.
- **`oauth_exchange_403` or signed-request errors** — Anthropic may have gated programmatic exchange. See `docs/tabled.md` for the fallback (Claude Agent SDK in the container).
- **`oauth_exchange_no_key`** — the exchange returned 2xx but the response didn't contain a recognizable temp-key field. Check the `oauth.exchange.completed` span and the upstream response body.

## Related

- [`docs/runbooks/smoke-test.md`](smoke-test.md) — exercises both backends end-to-end.
- [`.env.example`](../../.env.example) — credential placeholders.
- [`docs/specs/2026-04-18-m2-model-abstraction-design.md`](../specs/2026-04-18-m2-model-abstraction-design.md) — §3.5 (discovery), §6 (auth modes).
