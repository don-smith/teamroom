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
- **Group messages** — "Alice emails the #qa list" (multiple agents receive it).
- **System-event-triggered emails** — the event bus dispatches emails to subscribers when events fire. Subscribing to `test.failed` means receiving email when a test fails. The bus → email dispatcher is a first-class subsystem.
- **Harness endpoints with automated responses** — some email addresses are harness-managed and trigger behaviours (e.g., emailing a "deploy" address triggers a deployment; reply comes from the deploy subsystem).

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
- Two agents DM each other (inter-agent mechanism proven).
- They share a `/codebase` folder.
- Claude-assistant has fs tools.
- Conversation cap prevents runaway loops.

The "CLI user sees a final answer through the DM chain" piece is a casualty of the wrong primitive; it gets fixed for real when the email/event-bus direction lands in M4+.
