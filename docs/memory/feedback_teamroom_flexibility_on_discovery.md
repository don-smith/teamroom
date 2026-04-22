---
name: Team Room — do the best up-front architecture you can; be flexible when implementation reveals gaps
description: Up-front architectural design remains first-order; when implementation exposes a gap despite the effort, pivot gracefully rather than retrofit self-criticism. Don't lean on flexibility as a pass on design work
type: feedback
---

For Team Room, up-front architectural design at brainstorm and spec time remains the **first-order priority**. When there's time and energy to architect a piece well in the beginning, do that — don't rush to implementation and hope for the best. Every milestone should attempt the strongest architectural decisions we can make given what we know.

When implementation nevertheless exposes a gap the design didn't anticipate — as it did during M3 with the reply-routing/runtime-wrapping finding that broke the turn/reply primitive for multi-agent messaging — pivot **gracefully**:

- Narrow scope honestly.
- Capture the new direction as next-milestone context (e.g., in a `docs/<milestone>-followups.md` file, or directly in `docs/roadmap.md#backlog` at milestone close).
- Keep moving.
- Do **not** retrofit "we should have known" criticism onto the pivot — that traps future work in scenario-planning paralysis and trades real momentum for theoretical completeness.

**Equally important — the caveat that makes this a principle, not an excuse:** flexibility is the graceful fallback for gaps that implementation exposes *despite* our best design effort. It is not a substitute for that effort. Don't lean on flexibility more than we should. Don't use it as a pass on doing proper architecture at every milestone.

**Why:** User stated 2026-04-19/20 at M3 retro: *"I think as long as our process allows us to be flexible when these things happen, I think that's more important than trying to prevent it from happening."* And in the follow-up caveat: *"we should always attempt to make the best architectural decisions as we can… if we have the time and the energy to architect it well in the beginning, we absolutely should do that… we should not lean on our flexibility more than we should. This is not a pass to not do proper architecture at every milestone."*

The M3 incident: the milestone was scoped with the turn/reply primitive inherited from M1/M2. Brainstorming flagged that it wasn't quite elegant; we traded exhaustive up-front scenario-planning for momentum, shipping a narrowed design. The real-backend smoke test exposed that the primitive was fundamentally wrong for multi-agent messaging — the reply-routing bounce problem and the agent-runtime wrapping all LLM output in `{type:"reply"}`. We pivoted: narrowed the exit scenario, captured email-on-an-event-bus as the M4 thesis, kept moving. The outcome was a sharper understanding of what Team Room's messaging architecture actually needs than any amount of up-front brainstorming could have produced.

**How to apply:**

- **At brainstorm and spec time**, commit fully to the architecture work. Think through scenarios, probe primitives, run feasibility spikes. The goal is *not* exhaustive enumeration — the goal is best-effort design given the information we have.
- **When the user names a concern about the shape** (e.g., "doesn't feel elegant"), treat it as a signal to examine the primitive, not just the scope. Sometimes that examination confirms the shape is right; sometimes it reveals a gap. Either way, it's worth the hour.
- **During execution**, if a limitation surfaces that invalidates the primitive, pivot explicitly. Narrow the milestone's scope to what the current architecture can honestly deliver. Capture the forward direction in the milestone's followups doc so the next brainstorm opens with the sharpened thesis.
- **At retro time**, frame the pivot as the practice — not as a mistake to prevent. But also **do not generalise this to "we can skip design because we'll pivot anyway"** — that's the failure mode this rule is trying to block.
- **When in doubt** about whether to spike harder before a spec or ship and iterate: choose the spike if the subsystem is foundational and touched by many downstream consumers; ship-and-iterate if the subsystem is a leaf that can be replaced cheaply. M3's messaging primitive was foundational — that's the case where more up-front spike would have been worth it, and it's what the companion "full-chain feasibility spike" lesson from M3 addresses.
