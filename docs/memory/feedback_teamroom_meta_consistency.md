---
name: Team Room — build it with the team practices we want Team Room to produce
description: Team Room's own development uses the practices Team Room enables — reflection, retros, deliberate docs
type: feedback
---
Team Room is a product about building healthy agentic software teams. Its own development is expected to exemplify the practices Team Room is meant to enable: explicit roles and responsibilities, observability, reflection, retrospectives, continuous improvement, deliberate artifact management, and learning capture. Practice and product are meta-consistent — the way Team Room is built should match what a Team Room team would produce. Divergence between the two is a signal that either the practice or the product is off.

**Why:** User stated 2026-04-18 at the end of M1 brainstorming: "the way that I think about Team Room is it's gonna effectively be an agentic software team that's developing software with the right principles, practices, patterns... if I think about Team Room as a product and my building of that product, I would like to use those same principles of thinking about architecture, thinking about priority and planning and verification and design and architecture." User wants regular checkpoints, end-of-milestone retrospectives, explicit capture of what works/what doesn't, and awareness of markdown-file proliferation.

**How to apply:**
- **The myflow pipeline governs how we build features:** discover → research/design → implement → validate → land. Skills from imported workflow packages (e.g., `@juicesharp/rpiv-pi`, `@locksmithdon/dons-flow`) provide the practices for each stage. This replaces the earlier `docs/ways-of-working.md` model.
- Path conventions for this project: specs live in `docs/specs/`, plans in `docs/plans/`, retros in `docs/retros/`, runbooks in `docs/runbooks/`, as-builts in `docs/as-built/`, working-memory scratch at `.myflow/tabled.md` (local, gitignored).
- Standing instructions file is `AGENTS.md` (not `CLAUDE.md`) — model-agnostic by design.
- Treat retros as real rituals, not performative. Each retro ends with concrete items (changes adopted, artifacts created/removed), never just prose.
- Epiphanies during work are tabled to `.myflow/tabled.md`, not pursued mid-task. Processed during end-of-artifact checkpoints or retros.
- Promotion rule: once is a moment; twice is a pattern. Don't formalize on first occurrence.
- Before creating any new markdown file, check the doc inventory in AGENTS.md § navigating the codebase. Extend an existing doc if the content fits; justify a new category if it doesn't.
- Memory-type framing: Working (tabled.md) / Episodic (retros) / Semantic (specs, READMEs, as-builts) / Procedural (runbooks, AGENTS.md, skills). Apply when deciding where new knowledge lives.
- When you notice a gap in our own working practice, treat it as data about what Team Room (the product) may need to provide for its agents. Vice versa: features shipped in Team Room should be considered for application to our development practice.
- Don't let reflection drift into self-absorption. It exists to produce better work, not more meta-work.
