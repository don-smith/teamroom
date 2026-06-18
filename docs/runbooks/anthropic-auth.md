# OpenRouter credential setup (supersedes Anthropic auth)

> **This runbook has been superseded.** The Anthropic provider and `claude-assistant` agent were removed in the persona realignment (2026-06-18). All Team Room agents now route through OpenRouter.

## OpenRouter setup

The only credential Team Room needs is `OPENROUTER_API_KEY` in `.env`:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

Get a key from [openrouter.ai/keys](https://openrouter.ai/keys).

## Archived reference

The original content of this file (Anthropic OAuth and API-key auth for `claude-assistant`) has been superseded. See `docs/as-built/2026-04-19-teamroom-m2.md` for the M2-era Anthropic architecture record.

## Related

- [`.env.example`](../../.env.example) — credential placeholders.
- [`manual-cli-testing.md`](manual-cli-testing.md) — interactive single-turn testing.