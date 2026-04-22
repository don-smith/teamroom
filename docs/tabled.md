# Tabled — working-memory scratch pad

This file is the single working-memory location for anything noticed mid-task that we don't want to chase right now: epiphanies, follow-up items, design questions, technical-debt observations, ideas for later. Add an entry as a short bullet with enough context to reconstruct cold; remove it once it's processed (acted on, rolled into another document, or consciously dropped).

Keep this file small. If it grows past a screen of content, that's a signal to process, not to let it sprawl.

**Format for each entry:** a one-line title, a 2–4 line description, and (when known) where its next destination probably is — `docs/roadmap.md#backlog` is the most common destination at milestone close for items still relevant; other destinations include spec, runbook, skill, memory, retro, or drop.

**Milestone-close processing:** at the end of each milestone, sweep this file. Outstanding items worth keeping roll into [`docs/roadmap.md#backlog`](roadmap.md#backlog); completed/obsolete items are dropped. The file ends each milestone empty (or near-empty).

Mechanics in the `epiphany-tabling` skill (`.claude/skills/epiphany-tabling/`).

---

## Open entries

- **Sweep stale provider enumerations in docs during Task F1.** Task A2's code review noted two docs files list an outdated provider set (missing `ollama`, now also missing `deepagents` + `hermes`): `src/agent-config/README.md:9` (stale since M5) and `docs/runbooks/smoke-test.md:29,35` (M2-era, tangential — the smoke script only checks what it knows about). Not blocking A2. F1's runbook consolidation already sweeps `docs/tabled.md` entries; rolling these two into the sweep keeps providers consistent across the doc set. Next destination: fold into F1's runbook-consolidation sweep.

- **Telegram (+ Discord / Slack) as Team Room channels — elevate harness-native connectors to the daemon level.** Surfaced during M6 spec review: the biggest near-term unlock after multi-harness integration is a non-CLI external channel, with **Telegram as the highest-priority target** because its voice-message round-trip (send voice → agent reads codebase → reply as voice + text) unlocks off-desk agent collaboration during walks/commutes. Hermes ships native connectors for Telegram / Discord / Slack / WhatsApp / Signal / Matrix / SMS / etc.; the compelling architectural move is **not** to use them per-agent but to *elevate* them to Team Room's channel layer — one integration, all agents reachable. This reframes the roadmap's existing backlog item "Second channel (Telegram, Slack, voice, etc.)" (under Channel architecture evolution) by adding a concrete design seed (harness-native connectors as the implementation shortcut) and a concrete priority signal (voice is the killer feature). Out of M6 scope; becomes pressing immediately after — especially once M6's agents start wanting roles/responsibilities worth texting while away from the desk. Next destination: `docs/roadmap.md#backlog` under "Channel architecture evolution" at M6 close; expand the existing "Second channel" bullet with these points rather than duplicate.
