# Pi Agent Runtime Design

*Date: 2026-05-16. In-flight design for adding a Pi coding-agent based Team Room agent.*

## 1. Goal

Add a first-class Team Room agent runtime backed by the Pi coding agent SDK. The first concrete agent, `pi-coder`, is a general coding teammate: it can receive and send Team Room mail, converse through the CLI channel, inspect and edit the mounted codebase, and run shell commands within the same safety envelope as the existing containerized agents.

The integration should preserve Team Room's current security and composition principles: Team Room owns agent configuration, model routing, and credentials; agent containers receive only routing tokens and mounted working directories.

## 2. Key design decision: split runtime from model provider

Current `agent.yaml` uses `provider` for two coupled concerns:

1. Which runtime worker runs inside the container.
2. Which upstream model adapter the daemon model proxy uses.

That coupling worked while each provider implied one runtime shape:

- `anthropic` -> Anthropic SDK worker + Anthropic model adapter.
- `lm-studio` / `ollama` -> LangGraph worker + OpenAI-compatible model adapter.

Pi exposes the missing distinction. Pi is a runtime/harness, not an upstream model provider. A Pi agent may use Anthropic, OpenAI, LM Studio, Ollama, or another Pi-supported provider, but Team Room should still route those calls through the daemon proxy rather than giving the container direct credentials.

Add an optional `runtime` field to `agent.yaml`:

```yaml
name: pi-coder
runtime: pi
provider: anthropic
model: claude-opus-4-7
image_tag: teamroom-agent-pi-coder:latest
subscriptions: []
allowed_tools:
  - read
  - write
  - edit
  - bash
```

Backward compatibility remains: if `runtime` is omitted, infer it from `provider` exactly as today:

- `provider: anthropic` -> `runtime: anthropic`
- `provider: lm-studio` -> `runtime: langgraph`
- `provider: ollama` -> `runtime: langgraph`

This preserves all existing agent configs while making the Pi config honest.

## 3. Runtime architecture

Add `PiAgentWorker` under `src/agent-runtime/` and extend `buildWorker()` to dispatch by `TEAMROOM_RUNTIME` rather than `TEAMROOM_PROVIDER` when present.

The daemon injects both runtime and model-routing environment variables:

```text
TEAMROOM_RUNTIME=pi
TEAMROOM_PROVIDER=anthropic
TEAMROOM_MODEL=claude-opus-4-7
TEAMROOM_MODEL_BASE_URL=http://host.docker.internal:<proxy-port>
TEAMROOM_MODEL_API_TOKEN=<routing-token>
TEAMROOM_MCP_URL=http://host.docker.internal:<mail-port>/mcp
TEAMROOM_MCP_TOKEN=<mcp-token>
```

`PiAgentWorker` creates one long-lived Pi SDK `AgentSession` per container. It uses:

- `cwd: /codebase` when mounted, falling back to `/store` if no codebase mount exists.
- `SessionManager.inMemory(cwd)` for container-lifetime session state.
- explicit tool selection from `TEAMROOM_ALLOWED_TOOLS`, mapped to Pi tool names.
- a custom resource loader that includes `/AGENTS.md` plus Team Room wake/mail instructions.
- an in-memory model registry that points Pi at Team Room's model proxy, not at upstream credentials.

Each wake prompts the Pi session with a short Team Room wake instruction: check mail, respond or act as appropriate, and use the codebase tools when the task calls for it. The Pi session persists across wakes for as long as the container stays alive.

## 4. Model routing and credentials

Team Room remains the model-routing authority. `buildSpec()` continues minting a `TokenRegistry` routing token keyed by `provider` and `model`. For `pi-coder`, `provider` is the upstream provider (`anthropic` initially), not `pi`.

Inside `PiAgentWorker`, create Pi model configuration that targets the daemon proxy:

- for Anthropic models: an Anthropic-compatible provider whose `baseUrl` is `TEAMROOM_MODEL_BASE_URL`, whose API key is `TEAMROOM_MODEL_API_TOKEN`, and whose model id is `TEAMROOM_MODEL`.
- for OpenAI-compatible providers: an OpenAI-compatible provider with the same proxy base URL and routing token.

The container never receives real Anthropic, OpenAI, LM Studio, or subscription credentials. The daemon proxy accepts the routing token and substitutes the real credential through the existing adapter path.

## 5. Mail tools

Pi should not need to know MCP transport details. Register native Pi extension tools that wrap Team Room's existing mail MCP endpoint:

- `mail_list`
- `mail_get`
- `mail_send`
- `mail_reply`
- `mail_mark_read`
- `mail_archive`
- `mail_delete`

Each tool calls `TEAMROOM_MCP_URL` with `TEAMROOM_MCP_TOKEN`. The tool descriptions should use the same semantics as existing mail MCP tools and should be explicit about thread behavior, `unreadOnly`, `cc`, and `ccAll`.

This gives Pi the same team substrate as Anthropic and LangGraph agents while allowing Pi to use its own coding tools for codebase work.

## 6. Codebase access

No new mount shape is needed. Reuse the existing container mounts:

- agent `AGENTS.md` -> `/AGENTS.md`
- agent `store/` -> `/store`
- configured codebase path -> `/codebase` when available

Pi's working directory is `/codebase` when present so built-in `read`, `write`, `edit`, and `bash` tools naturally operate on the mounted repository. `/store` remains available for per-agent durable state.

## 7. Agent image

Add `agents/pi-coder/` with:

- `agent.yaml` using `runtime: pi`, `provider: anthropic`, and a concrete model.
- `AGENTS.md` describing the general coding-teammate role and mail-checking expectations.
- `Dockerfile` installing production dependencies, copying `dist/agent-runtime`, and starting `node /app/agent-runtime/main.js`.
- empty `store/` directory tracked with `.gitkeep`.

The image includes `@earendil-works/pi-coding-agent` as a runtime dependency of the Team Room package, so the compiled worker can import the Pi SDK inside the container.

## 8. Testing and acceptance

Automated coverage:

- agent config loader accepts optional `runtime`, infers old configs, and validates supported runtime/provider combinations.
- `buildSpec()` injects `TEAMROOM_RUNTIME` and still mints proxy tokens from model `provider` + `model`.
- `buildWorker()` dispatches `runtime: pi` to `PiAgentWorker` while preserving old behavior.
- Pi model-registry construction maps Team Room provider/model/proxy token into a Pi model without exposing real credentials.
- Pi mail tool wrappers call the existing mail MCP endpoint with the expected token and payloads.

Manual acceptance:

1. Build and install the CLI from this worktree.
2. Build `teamroom-agent-pi-coder:latest`.
3. Start `teamroom serve`.
4. `teamroom send pi-coder "read the README and reply with a one-sentence summary"` returns a reply.
5. `teamroom chat pi-coder` supports a short multi-turn conversation.
6. Ask `pi-coder` to make a tiny controlled edit in the mounted codebase and verify the edit on the host.
7. Confirm daemon logs show model calls routed through the Team Room proxy with `agentId: pi-coder` and no direct upstream credentials in the container config.

## 9. Deferred work

- Pi-native self-selection of model/provider from its own settings. Useful later, but first integration keeps Team Room's current config and credential-control model.
- Specialized Pi personas. Once `pi-coder` works, additional Pi agents should mostly be new `agents/<name>/AGENTS.md` + `agent.yaml` entries.
- Streaming Pi output into Team Room observability. First slice only needs final assistant text / mail replies; richer event capture can follow.
- General `openai` hosted provider in Team Room. The existing roadmap already defers a generic OpenAI-compatible provider until the third concrete backend forces the shape.
