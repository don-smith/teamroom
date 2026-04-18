---
name: Team Room — deliberate coupling and extensibility as a first-class concern
description: Coupling and extensibility are first-class architectural concerns; every boundary states what is shared vs. isolated, owned vs. used
type: feedback
---
For Team Room, coupling and extensibility are architectural concerns held at the same level of priority as correctness. Every design decision is evaluated against: what is shared, what is isolated, what is responsible for what, and how this choice affects the harness's ability to grow. The harness starts small and minimal but is expected to become comprehensive — memory, reasoning, delegation, collaboration, rich eventing, multi-model routing. Coupling choices made accidentally at M1 become very expensive to undo at M4+.

**Why:** User stated 2026-04-18 during M1 brainstorming: "I really want to think about the coupling and the extensibility of this harness... it's going to be really important that the architecture of this harness be really deliberate and intentional and not accidental. So I think the extensibility and coupling are going to have to be at the forefront of all of our decisions about how we build this harness." User is explicit that the small M1 surface does not excuse casual coupling.

**How to apply:**
- When proposing any boundary (module, interface, process, file, table, event type), state what is on each side and what is shared. If the answer is fuzzy, the boundary is wrong.
- Prefer narrow interfaces over wide ones. Prefer composition over inheritance. Prefer events over direct calls between subsystems. Prefer per-agent isolation over shared mutable state.
- Be explicit about what a subsystem *owns* and what it *uses*. Ownership goes in one place.
- When adding a new responsibility, ask: which existing subsystem is this — and if none fits cleanly, that's a signal that a new subsystem may be justified (or that the boundaries need redrawing).
- When considering shortcuts that couple previously-isolated concerns, weigh the cost of the coupling against later milestones' need to extend: memory per agent, multi-model routing per agent, inter-agent eventing, scheduling, etc.
- Extensibility tests: can a new agent be added without touching existing agents? Can a new channel be added without touching the daemon? Can a new event type be published without ceremony? If the answer to any of these is "not easily," the architecture needs work.
