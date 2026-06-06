# Pi Coder + OpenAI Provider — As Built

*Date: 2026-05-16. Frozen at commit. Future changes happen in a new as-built, not here.*

## 1. What was delivered

This feature adds `pi-coder`, a general coding teammate powered by the Pi coding agent SDK, and wires it into Team Room without bypassing Team Room's existing container, mail, codebase, and model-proxy boundaries.

`pi-coder` runs with:

```yaml
runtime: pi
provider: openai
model: openai/gpt-5.5
```

The live acceptance path succeeded end-to-end: Team Room spawned the `pi-coder` container, routed OpenAI traffic through the local model proxy using a Team Room routing token, exposed Team Room mail as Pi-native tools, and the agent replied to CLI mail. A follow-up manual acceptance conversation also verified that `pi-coder` could write into the mounted codebase.

Automated verification at close-out: `npm run typecheck` clean and `npm test` passing across 62 files / 320 tests.

## 2. Architecture as built

### Runtime is separate from provider

`AgentRuntime` is now explicit: `"anthropic" | "langgraph" | "pi"`. Agent configs may set `runtime`; older configs remain compatible by inference:

- `provider: anthropic` implies `runtime: anthropic`.
- `provider: lm-studio` / `provider: ollama` imply `runtime: langgraph`.
- `runtime: pi` selects the Pi SDK worker independent of the model provider.

This preserves the distinction that became load-bearing during the work: Pi is an agent runtime/harness, not an upstream model provider.

`buildSpec()` injects `TEAMROOM_RUNTIME` into containers. `buildWorker()` dispatches by `TEAMROOM_RUNTIME` when present, and falls back to `TEAMROOM_PROVIDER` for older containers.

### Pi worker

`src/agent-runtime/pi-worker.ts` creates a long-lived Pi SDK session per container. On each wake it prompts the session, lets Pi drive tool calls, and sends final text back through Team Room's stdout reply path.

The Pi worker receives only Team Room-scoped configuration:

- `TEAMROOM_PROVIDER`
- `TEAMROOM_MODEL`
- `TEAMROOM_MODEL_BASE_URL`
- `TEAMROOM_MODEL_API_TOKEN`
- `TEAMROOM_MCP_URL`
- `TEAMROOM_MCP_TOKEN`

It does not receive real upstream OpenAI credentials.

### Model routing for Pi

`src/agent-runtime/pi-model.ts` translates Team Room model settings into Pi `models.json` shape.

For OpenAI:

- Team Room config keeps `model: openai/gpt-5.5` for consistency with external model naming.
- Pi/OpenAI API receives `model: gpt-5.5`, stripping the `openai/` prefix.
- Pi uses the OpenAI chat-completions API against the Team Room proxy.

During acceptance, the Responses API path failed because Pi's current OpenAI Responses provider sends `store: false`, then later replays reasoning items that OpenAI does not persist under that mode. Chat completions accepted `gpt-5.5` with `max_completion_tokens`, so the final shipped mapping uses `openai-completions` for Team Room OpenAI.

### Team Room OpenAI provider

`Provider` now includes `"openai"`. `serve.ts` requires `OPENAI_TOKEN` and accepts optional `OPENAI_BASE_URL` (default `https://api.openai.com`). `composeModelProxy()` registers `openai` with the existing `OpenAICompatAdapter` in bearer-auth mode.

The proxy remains the credential boundary:

1. The daemon reads `OPENAI_TOKEN` from `.env`.
2. The daemon issues per-agent routing tokens.
3. Containers call the local Team Room proxy with the routing token.
4. The proxy substitutes the real OpenAI bearer token upstream.

`.env.example` documents `OPENAI_TOKEN=` as an empty placeholder; no real credential is tracked.

### Mail tools for Pi

`src/agent-runtime/pi-mail-tools.ts` wraps the existing Team Room mail MCP HTTP tools as Pi-native tools:

- `mail_list`
- `mail_get`
- `mail_send`
- `mail_reply`
- `mail_mark_read`
- `mail_archive`
- `mail_delete`

This is deliberately not a new mail subsystem. The Team Room mail MCP server remains the source of truth; Pi receives a runtime-specific adapter layer, just as LangGraph receives MCP tools through its own client.

### Container contract

`agents/pi-coder/` contains:

- `agent.yaml` — runtime/provider/model/image/tool declaration.
- `AGENTS.md` — teammate instructions and Team Room usage notes.
- `Dockerfile` — Node 22 Alpine image that runs the compiled Team Room worker.
- `store/.gitkeep` — persistent per-agent store directory marker.

The image build remains the standard Team Room pattern:

```bash
docker build -t teamroom-agent-pi-coder:latest -f agents/pi-coder/Dockerfile .
```

## 3. Decisions and adaptations

- **Runtime/provider split is first-class.** This prevents future external harnesses from being modeled as fake providers.
- **OpenAI is a first-class provider, not a Pi escape hatch.** GPT-5.5 access goes through Team Room's proxy and token registry, preserving centralized credential control.
- **Pi mail integration is an adapter over existing mail MCP.** No duplicate mail APIs or stores were created.
- **Use chat completions for `gpt-5.5` in this integration.** It worked through Pi and the Team Room proxy; Pi's Responses provider currently conflicts with OpenAI non-persistence behavior when tool/reasoning items are replayed.
- **Keep `openai/gpt-5.5` in Team Room config, strip only at the Pi/OpenAI API boundary.** This keeps human-facing config expressive while satisfying OpenAI's model id expectations.

## 4. Verification

- Unit and integration coverage added for runtime parsing/inference, runtime env injection, Pi model config, Pi mail tools, Pi worker construction, OpenAI provider composition, and loading the real `agents/pi-coder` config.
- Docker image built successfully with Node 22.
- Live acceptance confirmed CLI → daemon → container → Pi SDK → Team Room proxy → OpenAI → mail reply.
- Close-out verification: `npm run typecheck`; `npm test`.

## 5. Known follow-ups

- The Team Room CLI should be run with Node 22 until the ambient Node/native-module mismatch is resolved.
- The proxy now logs non-secret request method/path and bounded body previews for upstream diagnostics; keep watching whether that detail should remain permanently or be tightened after more provider debugging.
- Pi's OpenAI Responses mode may become viable later if its persistence strategy changes or Team Room adds provider-specific request rewriting, but chat completions is the shipped path.

## 6. Commit range

Branch `pi-coding-agent`, 11 commits from `b4b6249` through `1293cf0` before this as-built close-out commit.
