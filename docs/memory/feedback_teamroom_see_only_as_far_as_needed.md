---
name: Team Room — see only as far as needed, not further
description: For Team Room, aggressively defer formalization and abstraction until a concrete second example forces the shape
type: feedback
---
For Team Room, the user explicitly wants to "see out as far as we need to, but not any further." Defer formalization of processes, tooling, and abstractions until there's a concrete second example to learn from. The first instance of anything (first agent, first channel, first tool integration) is allowed to be hand-crafted and imperfect — it exists to surface the shape, not to define the pattern.

**Why:** User stated 2026-04-18 during M1 brainstorming, specifically rejecting the idea of a `teamroom agent add` command for the first agent: "a single command for building an agent doesn't really have much value... when we're building the second one, that's when we'll start to establish the run book and define the skill and all of the other things we need." User called out that the first agent is about "finding the shape" and fully expects to adjust when building the second. This is a deliberate anti-premature-abstraction stance rooted in "learning as we go."

**How to apply:**
- When proposing a spec, ask: is this abstraction justified by *two* concrete cases, or are we speculating from one?
- Prefer hand-crafted config/files for first-of-kind resources; introduce tooling (CLI commands, scaffolds, reconcilers) only when a second instance proves the pattern.
- Formalize via runbooks/skills/tooling at the N=2 boundary, not earlier.
- The cost of redoing work at N=2 is accepted. Don't front-load flexibility "in case."
- Applies especially to: agent onboarding tools, channel scaffolds, memory shape, evaluation harness shape.
