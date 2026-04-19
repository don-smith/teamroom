# Team Room Roadmap

*Living document. Supersedes the milestone list in [`team-room-context.md §7`](../team-room-context.md) (which remains as the frozen original snapshot). Updated at each milestone close. Ordering is subject to change as we learn; see each milestone's retro + as-built for the reasoning when it shifts.*

## Milestones

| # | Title | Status | Close date | Artifact |
|---|---|---|---|---|
| M1 | One agent that works | Shipped | 2026-04-18 | [As-built](as-built/2026-04-18-teamroom-m1.md) |
| M2 | Model abstraction layer (multi-model credential proxy) | Shipped | 2026-04-19 | [As-built](as-built/2026-04-19-teamroom-m2.md) |
| M3 | Team substrate (narrowed ship) | Shipped | 2026-04-20 | [As-built](as-built/) (pending write at M3 close) |
| **M4** | **Agent mail — email on an event-bus backbone** | **Next** | — | Forward thesis: [`m3-followups.md §6`](m3-followups.md) |
| M5 | Per-agent memory | Future | — | Originally M4 in `team-room-context §7`; shifted down when mail was promoted |
| M6 | Scheduling | Future | — | Originally M5 |
| M7 | Evaluations | Future | — | Originally M6 |
| M8 | Team ceremonies + self-learning | Future | — | Originally M7 |

## Why this file exists

`team-room-context.md` is a frozen snapshot of the original brainstorm. Its `§7` milestone list was the best estimate at that time. During M3 execution the team-substrate thesis sharpened: the messaging primitive we inherited from M1/M2 (turn/reply) turned out to be the wrong metaphor for multi-agent communication. Email on an event-bus backbone is the right one. That insight made agent mail the obvious next foundation — memory and scheduling will land on top of a working communication substrate, not alongside it.

Rather than edit the frozen original, this file is the single **living** source of truth for what's next. Every milestone close updates it.

## Update cadence

At every milestone close:
- Mark the completed milestone's status (Shipped) and link its as-built.
- Re-examine the "Future" order in light of what the milestone taught us.
- If the order changes, note why (a one-liner in the rationale column is enough; deeper rationale goes in the milestone's retro).

## Related

- [`team-room-context.md §7`](../team-room-context.md) — frozen original roadmap. Consult for historical context; do not edit.
- [`docs/m3-followups.md §6`](m3-followups.md) — full forward-thesis for M4 (agent mail direction).
- [`docs/ways-of-working.md`](ways-of-working.md) — document inventory including this file.
- [`docs/retros/`](retros/) — per-milestone retrospectives; each one's action items feed back here.
