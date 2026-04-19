# Tabled — working-memory scratch pad

This file is always in place. Add an epiphany as a short bullet with enough context to reconstruct later; remove it once it has been processed (either acted on, rolled into another document, or consciously dropped). Keep this file small. If it grows past a screen of content, that's a signal to process, not to let it sprawl.

Format for each entry: a one-line title, a 2–4 line description, and (when known) where its next destination probably is (spec, runbook, skill, memory, retro, drop).

Mechanics in the `epiphany-tabling` skill (`.claude/skills/epiphany-tabling/`).

---

## Open entries

- **Runtime subscription changes take effect without daemon restart.** During M3
  brainstorm (2026-04-19) we locked in option (A): static subscriptions in
  `agent.yaml`, daemon reads at boot / on config reload. User explicitly tabled
  the richer future: an agent being able to change its own subscriptions and
  notification settings (either by editing its `agent.yaml` or via a future
  tool) and have the change take effect **immediately**, not on the next daemon
  restart. Subsumed by — but worth keeping until retro — the email/event-bus
  direction captured in `docs/m3-followups.md §6`, since inbox-management is
  the natural place for runtime subscription changes to live. Destination at
  M3 retro: probably drop here and fold into the entry 6 brainstorm inputs.

- **M3 hit its architectural wall mid-execution.** During the DM-round-trip
  integration test for M3 (2026-04-19) the reply-routing bounce problem
  surfaced: a reply from a DM-triggered turn has no way to reach the original
  CLI user. This exposed that the turn/request-response primitive we inherited
  from M1/M2 is the wrong metaphor — email on an event-bus backbone is what
  agent messaging actually wants to be. **Full capture lives in
  `docs/m3-followups.md §6`**. Action for M3: narrow the exit scenario
  (final-CLI-reply piece is out of scope); proceed to T21/T22/T23 with honest
  docs and a narrowed smoke test. Action for M3 retro: promote entry 6 to the
  M4 brainstorm's opening context.
