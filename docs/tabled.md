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
  restart. Implies a file-watcher on `agents/*/agent.yaml` (and/or a
  `subscribe()` tool writing to `store/subscriptions.json` or a DB table), plus
  a hot-reload path in the daemon that re-computes the subscription index and
  any pending wake-up routing tables without dropping in-flight work. Probable
  destination: graduate to `docs/m3-followups.md` once M3 spec lands, to be
  picked up when a concrete agent has a real reason to self-modify its
  attention at runtime.
