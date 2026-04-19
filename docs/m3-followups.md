# Milestone Follow-ups

*Originally created at M2 close for items deferred from M2 into M3 (entries 1–5). During M3 execution a substantial architectural direction surfaced (entry 6) — that's the M3 → M4+ deferral and is the largest item here. Trigger conditions noted on each entry so the next brainstorm can decide which earn their slot.*

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

---

## 6. Post-M3 direction: messaging as email on an event-bus backbone

*Surfaced during M3 execution (2026-04-19) when the reply-routing design gap exposed that our turn/request-response model is the wrong primitive for what Team Room actually wants. The DM mechanism we shipped in M3 is scope-cut-M2, not the elegant substrate. Capturing here so the next brainstorm can pick it up.*

### The insight

The turn → reply primitive we inherited from M1/M2 presumes request-response semantics: an agent is called, does work, replies. That maps cleanly to a single CLI turn, but it fractures the moment an agent needs to ask a peer for help mid-task. Who is the "caller" of the peer's response? Is the agent's post-peer-reply work a "new turn" or a "continuation"? The bounce problem (reply-to-sender instead of reply-to-root-caller) is a symptom, not the disease. The disease is that we're forcing request-response on what is fundamentally asynchronous, many-to-many communication.

**Email is the right metaphor.** Every message is one-way with metadata. Recipients can respond if they want — that's a new message, not an implicit coupling. Conversations are threads, not call chains. Agents manage their inbox however they want. There is no "return address obligation" baked into the protocol. MCP agent mail is popular for exactly this reason — the shape fits.

### The architecture

**Event bus is the backbone of the harness.** Everything flows through it:
- Inter-agent messaging.
- System events (tests failing, deployments breaking, merges landing, model calls completing, turns starting, agent hooks firing, human inputs arriving on channels).
- Harness-internal behaviour (subsystems reacting to events without an agent recipient).

**Durability is required.** The bus needs to survive restarts and crashes. Prefer an **embedded pub/sub with durability** — the SQLite equivalent of Redis. Stays aligned with the "minimize long-running process dependencies" memory (`feedback_teamroom_minimize_process_deps`). Candidates to explore: NATS JetStream (file-backed, no external daemon in some modes), a thin pub/sub wrapper over SQLite's WAL, LiteFS, or an in-process pub/sub where the persister is SQLite. Avoid Redis itself — it's a separate long-running process.

**Agent-facing: email.** An agent's inbox is a durable, ordered list of messages addressed to the agent (directly or via group/topic/system-event subscription). Agents read, reply, forward, archive, ignore, prioritise, triage — whatever their skills support. Responses are new messages, not part of a turn's exit protocol. Every email carries metadata (sender, references, subject/type, timestamp) so agents can reason about context without the harness imposing request-response structure.

### What "email" encompasses

- **Direct agent-to-agent messages** — "Alice emails Bob."
- **Group messages / mailing lists** — "Alice emails the #qa list" (multiple agents receive it).
- **System-event mailing lists** (bridge from events to agents) — when an event fires that agents might want to subscribe to, the harness has a mailing list for it (e.g., `test.failed`, `deploy.broken`, `merge.landed`). The event bus routes a firing to the list → every subscriber gets email. This **collapses the "alerts" concept into mail**. Agents don't subscribe to events directly; they subscribe to the mailing lists that represent those events. One primitive, one mental model.
- **Harness endpoints with automated responses** — some email addresses are harness-managed and trigger behaviours (e.g., emailing a "deploy" address triggers a deployment; the reply comes from the deploy subsystem).

### Unified mail: channels as gateways

From the agent's perspective, **every inbound interaction is email, regardless of source**. The CLI isn't a separate concept — it's a channel that translates human input into email addressed to an agent, and translates the agent's outbound email back to the human's terminal. A future Telegram channel is the same shape: it translates Telegram messages into email and email back into Telegram.

Envelope structure (shape-only, specifics come in M4 brainstorm):

- **From.** Who sent it (agent id, or a channel-prefixed identity like `cli:don` for the human-via-CLI case).
- **To.** One or more recipients (agent ids, mailing-list ids, or channel-prefixed humans).
- **Cc / Reply-to.** Familiar email semantics — threads survive multi-party exchanges; replies go to the sender by default but `reply-to` can redirect.
- **Subject / body / references / thread-id.** Threading uses references like real email.

This framing closes the exit-scenario gap from M3. A CLI user sending a message via `teamroom send` creates an email addressed to the agent; the agent replies and the CLI channel delivers the reply to the human. If the agent needs a peer's help mid-task, it sends email to a peer (or a mailing list); the peer replies; the agent's reply to the original human is a separate outbound email. Every hop is explicit, durable, and the thread-id stitches them together.

### What this replaces

- The **turn contract / request-response** framing — gone. No caller obligation; agents respond when they choose.
- **Per-subscription wake flags** — replaced by inbox semantics (agent decides when to process).
- **Conversation-as-turn-chain** (what we built in M3 via `conversation_id`) — replaced by email threading (references/in-reply-to headers).
- **The DM stdout verb** — replaced by `send-email` verb with to/cc/subject/body semantics.

### Container lifetime becomes its own concern

The current per-turn ephemeral container model was convenient for M1/M2 but doesn't map cleanly to "agents check email when they want." The right shape might be:
- **Longer-lived containers** that poll their inbox.
- **Hybrid** — ephemeral containers spawned on inbox-event, but the inbox itself is durable outside the container.
- **Push-pull** — the harness wakes a container when new mail arrives; the container drains the inbox, acts, sleeps.

Whichever shape wins, container lifetime is **decoupled from message handling** — you don't get a new container per message; you get a session that processes mail.

### What M3 still contributes

M3's work isn't wasted when we graduate to this model:
- **Schema columns (`channel`, `topic`, `from_agent_id`, `conversation_id`)** — close relatives of email headers (list-id, from, references). The DB columns likely evolve to: `to`, `cc`, `subject`, `references`, `in_reply_to`, `body` — but the shape is familiar.
- **Subscription index** — becomes a mailing-list + system-event subscription index. Same mechanism, richer semantics.
- **Conversation cap** — becomes a per-thread or per-agent email rate limit.
- **`/codebase` mount** — unchanged, passes through.
- **Claude fs tools** — unchanged.

### Proposed M4 or later brainstorm

When the next brainstorm opens, start from this capture, not from the M3 spec. The directional questions:

1. **Embedded pub/sub + durability.** Which mechanism? (SQLite-backed, NATS JetStream in embedded mode, other?) Constraint: no separate long-running process.
2. **Email schema.** Headers, body, thread references, attachments (files? structured data?), delivery semantics (at-least-once? exactly-once?).
3. **Inbox management primitives.** What skills/tools do agents get to triage, prioritise, batch, archive?
4. **System-event → email dispatch.** Registration model; filtering; dead-letter behaviour.
5. **Container lifetime.** Continues as an open question; may land alongside this or as a separate milestone.
6. **MCP agent mail reference.** Worth reading the MCP agent mail spec/impl before the brainstorm — the shape is convergent.

### Trigger for picking this up

When M3 ships (the scope-cut version) and the next milestone starts. This is almost certainly the biggest piece of M4 work — it's the thesis of the product, not an auxiliary subsystem.

### What we're doing with M3 right now

Taking the full CLI-user-final-reply exit scenario off the table for M3. M3's exit narrows to:
- DM primitive at the **daemon plumbing level** (stdout parsing, subscription routing, conversation_id propagation, cap) — proven by unit + integration tests with `FakeRunner`.
- Shared `/codebase` mount — wired.
- Claude-assistant fs tools — enabled.
- Conversation cap prevents runaway loops.

### Sharper gap exposed by the smoke test run

When the smoke test against real backends ran, Claude Opus *correctly* formatted the requested `{"type":"dm","to":"studio-assistant","body":"dm-…"}` JSON line in its response. But the line landed on **CLI tail output**, not as a routed DM. Why: `src/agent-runtime/runtime.ts` wraps the LLM's entire text response in a single `{type:"reply", body: "<all the text>"}` stdout event. The daemon's stdout parser sees a `reply`, not a `dm`. The JSON line exists only as text *inside the reply body*.

**The M3 DM primitive works at the daemon plumbing layer but real LLM agents cannot use it** — there's no path for an LLM agent's text output to become a typed `dm` stdout event. That means the end-to-end smoke test for the DM primitive is withdrawn from M3 (the `run_dm_primitive_check` addition was reverted; only the plumbing-layer tests stay).

This gap is exactly what the email/event-bus direction fixes. Concretely: agents get a **`send-email` tool** (or equivalent) that they *call* rather than *format as stdout*. The tool's side effect is to enqueue a typed email event on the bus. The agent's natural-language text stays plain text; structured sends are a distinct channel. That's the cleanest way to close this gap and it's the M4+ thesis.

### Why the smoke test finding is a useful signal

This was discovered by attempting a real end-to-end flow — exactly the kind of feasibility issue M2's retro said we'd try to catch earlier. The existing FakeRunner-based unit/integration tests covered the daemon plumbing correctly; only the live smoke test could expose that real LLM agents can't produce a typed DM event. That validates the **"always do a real-backend smoke check at milestone exit"** discipline we'll carry forward.

The "CLI user sees a final answer through the DM chain" piece, and "real LLM agents can emit DMs at all," are both casualties of the wrong primitive. Both get fixed when email/event-bus lands.
