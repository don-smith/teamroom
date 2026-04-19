# M3 Follow-ups — items deferred from M2

*Created at M2 close (2026-04-19). Each entry was tabled during M2 execution as out-of-scope for the M2 milestone but in-scope for M3 or beyond. Trigger conditions noted so the M3 brainstorm can decide which earn their slot.*

---

## 1. Multi-model-per-agent and per-request model selection

User confirmed 2026-04-18 during M2 brainstorm: an agent will eventually have access to multiple models and choose per request, or at least per conversation. Beyond per-call selection: agents will have *skills* and an *array of models* with instructions on which model to use for which type of work (cheap/fast for triage, big for synthesis).

M2's `TokenEntry` type and `agent.yaml` schema carry an inline comment noting the future list-shape — the registry value will evolve when this lands.

**Trigger:** a concrete agent has a real reason to switch models per call.

## 2. Streaming model responses (and related proxy / transport refactors)

M2 keeps the agent-runtime non-streaming (matches M1). Three coupled refactors hinge on this:

- **SSE pipe + usage parsing.** Anthropic's native streaming is SSE; the proxy will need a true SSE pipe and to parse usage from the terminal `message_stop` event.
- **`LocalModelProxy` refactor seam.** The proxy currently buffers `upstreamChunks: Buffer[]` fully before responding (required for `extractUsage`). Streaming requires a different shape — this is the refactor seam when it lands.
- **Container ↔ proxy transport.** Currently plain HTTP/1.1 keep-alive. May need re-evaluation when streaming arrives: SSE (matches Anthropic upstream), HTTP/2 (multiplexing), WebSockets (probably overkill for this shape), tRPC (different abstraction layer). Defer the comparison until streaming forces the question.
- **Wall-clock deadline alongside idle timeout.** `upstreamTimeoutMs` is Node's `ClientRequest.setTimeout` — idle/inactivity-based, not wall-clock. Non-streaming M2 workloads return the whole body in one chunk so the effective behaviour matches a wall-clock. Once streaming lands, a slow-drip upstream can keep the socket alive indefinitely — at that point add a separate `deadlineMs` option enforced with `setTimeout(() => upstreamReq.destroy(...), deadlineMs)` on start. Don't add it now: it would prematurely kill legitimate long non-streaming completions and has no defensive value until streaming exists.

**Trigger:** an agent surface needs realtime streaming (long completions, voice, etc.).

## 3. Tool-call telemetry as child spans of the turn trace

The span-shaped log vocabulary established in M2 (`{event, traceId, spanId, parentSpanId, ...}`) is already designed to extend to tool-call records (`tool.call.completed`). No M2 work; the pattern is in place to absorb when agents start emitting tool calls.

**Trigger:** agents emit tool calls — likely M3+ when LangGraph or tool-using agents land.

## 4. CLI as a `Channel` impl when channels become first-class

`teamroom send` / `teamroom tail` currently write directly to `MessageRepo` and subscribe directly to `NotifyBus`. When channels become a first-class abstraction (M3 team-substrate or whenever the first non-CLI channel lands — Telegram, Slack, etc.), the terminal CLI should be a `Channel` impl like the others, not a special-cased DB writer.

**Trigger:** first non-CLI channel design lands.

## 5. `teamroom debug-agent` CLI (was Task #38 in M2)

Non-blocking friction-reducer deferred from M2. Would allow debugging an agent's container interactively without going through full daemon orchestration. Smoke-test prep during M2 was tractable enough that it didn't earn priority.

**Trigger:** debugging friction during M3 work makes it acute enough to justify.
