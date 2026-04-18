# Tabled — working-memory scratch pad

This file is always in place. Add an epiphany as a short bullet with enough context to reconstruct later; remove it once it has been processed (either acted on, rolled into another document, or consciously dropped). Keep this file small. If it grows past a screen of content, that's a signal to process, not to let it sprawl.

Format for each entry: a one-line title, a 2–4 line description, and (when known) where its next destination probably is (spec, runbook, skill, memory, retro, or drop).

---

## Open entries

- **Plan drift: `.gitignore` rule prevents `.gitkeep` from being tracked.** The plan's `.gitignore` has `agents/*/store/` (excludes the directory) + `!agents/*/store/.gitkeep` (intends to track the placeholder). Git does not support re-including files inside an excluded parent directory. Implementer worked around with `git add -f`. Proper fix: change to `agents/*/store/*` (ignore contents, not directory itself) + `!agents/*/store/.gitkeep`. Plan at ~line 223 — amend at M1 close.

- **Plan drift: Anthropic SDK `TextBlock` type narrowing (Task 23c).** The plan's type predicate `(b): b is { type: "text"; text: string } => b.type === "text"` is incompatible with `@anthropic-ai/sdk@0.65`'s current `ContentBlock` union — `TextBlock` now requires a `citations` field. Impl adjusted to a plain filter + cast. Plan at ~line 4181 — amend at M1 close.

- **Daemon shutdown polish for M2.** Three small items flagged during Task 16–18 review: (a) `daemon.ts` lines 61–62 use a dynamic `import("node:fs")` that has no justification — consolidate to the top-level static import. (b) `stop()` does not unlink the PID file — stale PID after clean shutdown. (c) `shutdown` in `main.ts` is not idempotent under rapid SIGINT+SIGTERM; `db.close()` on an already-closed better-sqlite3 DB throws. Add a `let stopped = false` guard. All three are post-M1 polish.

- **Reconciler blind spot: `pending` turns with running containers.** `processTurn` calls `turnRepo.markRunning` AFTER `runner.run()` returns. During the actual container run, the turn row stays at `status='pending'` with `container_id=NULL`. Task 16's reconciler looks for orphaned `status='running'` turns — it will miss a turn whose daemon crashed mid-container-execution. Two options for M2+: (a) `markRunning` immediately before `runner.run()` (requires the runner to give a container ID up-front or accept a placeholder), (b) reconciler also reclaims stale `pending` turns by age. Spec §12 "reconcile" description should probably be updated. Tracked for Task 16 and M1 retro.

- **Plan drift: `parseEvent` spread ordering in `docker-runner.ts`.** The production code at ~line 67–78 spreads `...obj` AFTER setting explicit `type`/`phase`/`msg` fields, so malformed JSON with `obj.type !== "status"` could overwrite the typed `type` field. Correct form is `{ ...obj, type: "status" as const, phase: obj.phase }`. Inherited from plan; not a blocker for M1 (malformed JSON is warn-logged and dropped by current path), but worth fixing before M2 if `parseEvent` is touched.

- **Plan drift: `buildDockerRunArgs` test 1 had wrong env order.** Test 1 listed env vars in logical order but expected argv in that same order; test 2 verifies alphabetical sorting; implementation sorts alphabetically. Tests 1 and 2 were mutually inconsistent. Implementer corrected test 1's expected argv to alphabetical. Plan at `docs/plans/2026-04-18-teamroom-m1-plan.md` ~line 1930 (Task 11 test 1) — amend at M1 close.

- **Plan drift: `FileNotifyBus` named-type import.** The plan used `chokidar.FSWatcher` after a default-only import; TypeScript strict rejects this with "Cannot find namespace 'chokidar'". Fixed inline with `import chokidar, { type FSWatcher } from "chokidar"`. Plan at `docs/plans/2026-04-18-teamroom-m1-plan.md` ~line 1695 — amend at M1 close.

- **Plan drift: `FileNotifyBus` — two bug fixes applied, plan text stale.** During Task 10, the implementer caught (and reviewer confirmed) two genuine bugs in the plan's `FileNotifyBus`: (1) chokidar readiness race — events published before `ready` can be missed, fixed with `await watcher.on("ready", ...)` before initial drain; (2) `close()` does not wake sleeping iterators, fixed with a bus-level `sleepingResolvers: Set<() => void>`. Test file and interface unchanged; internal impl diverges from `docs/plans/2026-04-18-teamroom-m1-plan.md` lines ~1793–1839. Probable destination: amend plan at M1 close, or in the M1 retro's "promote to artifact" section as a pattern (plan drift → retro entry).

- **`@types/node` version vs. runtime target.** `package.json` pins `@types/node@^22.8.0` but `engines.node` is `>=20`. Node 22 types include APIs not in Node 20; TS won't catch Node-22-only API usage. Reviewer flagged this at Task 1 as "low-risk but worth correcting before `src/` fills up." Fix is a one-line change to `^20.0.0` + `npm install`. Probable destination: resolved before any Task that touches Node stdlib APIs (most likely before Task 5 — DB layer uses `node:fs`).

- **Runbook vs. skill boundary.** Working heuristic: *a runbook is a procedure that orchestrates one or more skills.* Skills are the reusable process primitives; runbooks compose them into Team-Room-specific procedures (e.g., "add a new agent," "add a new channel"). This needs validation once we've produced a skill and a runbook that share a boundary. Probable destination: clarified in `docs/ways-of-working.md` or as its own short skill/runbook-standards doc after the first concrete example.
