# M1 Closeout — Pending Tasks (for a fresh session)

*Working-memory doc. Created at end of M1 execution session 2026-04-18. Delete when all tasks complete.*

## How to use this document

Read `docs/retros/2026-04-18-m1.md` for what M1 delivered and the decisions already made. This document is the executable closeout plan — the retro's action-items section expanded to reflect decisions from the retro-review discussion. New session: read this, then execute top-to-bottom.

## Key references

- Retro: `docs/retros/2026-04-18-m1.md` (committed; frozen)
- Ways of working: `docs/ways-of-working.md` (needs amendments per §Task-H)
- Standing instructions for AI assistants: `AGENTS.md` (needs amendments per §Task-A, §Task-B)
- Current tabled items: `docs/tabled.md`
- Plan (to be retired per §Task-C): `docs/plans/2026-04-18-teamroom-m1-plan.md`
- Design spec (to be consumed into as-built per §Task-C): `docs/specs/2026-04-18-teamroom-m1-design.md`
- Current memories (living outside the repo; to be moved per §Task-A): `/Users/don/.claude/projects/-Users-don-projects-teamroom-teamroom/memory/`

## Decisions made during retro review

These are additions/refinements to the original retro action items. Rationale preserved so future-Claude can judge edge cases.

### D1. Memories live in-repo, at `docs/memory/`

**Decision:** Move every memory file from `~/.claude/projects/-Users-don-projects-teamroom-teamroom/memory/` into `docs/memory/` in the repository. All future memory writes go to `docs/memory/`; the Claude Code auto-memory path is no longer used for Team Room.

**Rationale:** The prior location was invisible to the user, invisible in git, and invisible to any AI agent that isn't this specific Claude Code session. If the codebase IS the knowledge graph, memories belong in the codebase.

### D2. Announce memory writes

**Decision:** Whenever Claude writes, updates, or removes a memory entry, it announces the action and reason in the conversation BEFORE making the change. Like skill invocation announcements.

**Rationale:** User stated they couldn't see memory writes happening during planning. Visibility enables real-time pushback.

### D3. As-built pattern via repo-specific skill + new `docs/as-built/` folder

**Decision:**

- Create a repo-specific skill (not a superpowers generic) that codifies the as-built pattern. Location: inside the plugin/skill directory for this project, or wherever Team Room's own skills will live. This needs a bit of discovery at execution time — check if `.claude/skills/` or similar is the right home, and if superpowers gives a clear pattern for repo-specific skill layout.
- Create `docs/as-built/` directory.
- Write the M1 as-built to `docs/as-built/2026-04-18-teamroom-m1.md`.
- After the as-built lands, purge `docs/specs/` and `docs/plans/` — leave each as an empty folder with a `.gitkeep`, retaining the structure for the next milestone's workflow (spec + plan → as-built → purge → repeat).

**Rationale:** Specs and plans are scaffolding; they create noise once the work is done. The as-built is the permanent high-signal artifact. User has used this pattern successfully in prior projects and wants it established for Team Room.

### D4. Split ways-of-working: procedural → skills/runbooks; semantic stays

**Decision:** `docs/ways-of-working.md` currently mixes procedural content (reflection rhythms, retro format, promotion rules) with semantic content (memory-type mapping, document inventory, principles, failure modes). Split: procedural parts become skills (or runbooks where specific). Semantic parts stay in ways-of-working.

**Partial resolution of the runbook-vs-skill tabled question:**

- **Skill:** a repeatable process pattern ("how to retro", "how to write an as-built", "how to handle a plan drift during execution"). Applies across individual instances.
- **Runbook:** a specific operational procedure ("running the smoke test", "adding a new migration", "adding a new agent"). Instance-oriented.

Skills are abstractions; runbooks are concrete. Skills are meta (how to DO the thing); runbooks are the thing. Further refinement may happen when the first agent-addition runbook lands.

**Procedural content to extract from ways-of-working:**

- Reflection rhythms (epiphany tabling, end-of-artifact checkpoint, retro, ad-hoc capture) → skill(s)
- Promotion rule ("once is a moment; twice is a pattern") → skill
- As-built rhythm → its own skill (per §Task-C)
- Proliferation test → skill or inline rule

**Semantic content that stays:**

- Principles (meta-consistency, deliberate-coupling-and-extensibility, etc.)
- Memory-type-to-markdown mapping
- Document inventory
- Cross-pollination / practice-product divergence
- Failure modes

### D5. CLI ergonomics: don't modify user's PATH

**Decision:** `npm link` modifies the user's PATH implicitly. User prefers explicit control. Alternative:

- Add an `npm run install-cli` (or similar) script.
- The script accepts a target directory as an argument — e.g., `npm run install-cli -- ~/bin` — and writes a symlink to `dist/cli/main.js` into that directory under the name `teamroom`.
- Assumption: the user has already added that target directory to their PATH.
- Precondition: `npm run build` has run (or the install-cli script runs it first).

This avoids touching PATH at all. The user controls where the symlink lives; the script just writes it.

**Document prominently in root `README.md`:** preconditions, the one-time install command, and usage examples (`teamroom serve`, `teamroom send "hi"`, etc.).

### D6. Runbook set for M1

All five approved:

- `docs/runbooks/running-tests.md`
- `docs/runbooks/smoke-test.md`
- `docs/runbooks/adding-a-migration.md`
- `docs/runbooks/manual-cli-testing.md`
- `docs/runbooks/inspecting-bus-events.md`

Each is concise: preconditions, numbered steps, "what success looks like," short troubleshooting list. Not essays.

---

## Task list (execute in this order)

Each task has a clear outcome. Don't batch unrelated tasks into single commits; prefer small coherent commits per logical unit.

### Task A — Memory relocation and announcement discipline

- [ ] Create `docs/memory/` directory.
- [ ] Copy every file from `~/.claude/projects/-Users-don-projects-teamroom-teamroom/memory/` to `docs/memory/`. Expected files:
  - `MEMORY.md` (index)
  - `feedback_teamroom_minimize_process_deps.md`
  - `feedback_teamroom_see_only_as_far_as_needed.md`
  - `feedback_teamroom_coupling_and_extensibility.md`
  - `feedback_teamroom_testability_and_di.md`
  - `feedback_teamroom_meta_consistency.md`
  - `project_teamroom_langgraph_direction.md`
- [ ] Verify content is identical; no changes during copy.
- [ ] Add a reading-order entry to `AGENTS.md` pointing at `docs/memory/MEMORY.md` (should be step 1 or 2 — recurring preferences are high-priority context).
- [ ] Add a row to `docs/ways-of-working.md` document inventory for `docs/memory/` (memory-type: cross-cutting; role: recurring preferences and project context; freshness: update or remove as context shifts).
- [ ] Update `AGENTS.md` with a new principle: "Announce memory writes/updates/removals in conversation before making them." Include the rationale (transparency to the user).
- [ ] Delete the original `~/.claude/projects/.../memory/` files **only after** confirming the new location is committed and working — keep them as a safety net during execution.
- [ ] Commit.

Commit message suggestion: `docs(m1-close): relocate memories to docs/memory/ and add announce-on-write discipline`.

### Task B — Clean up the retro's references to moved memories

- [ ] The retro's §4 and §5 sections reference specific memory file names (e.g., `feedback_teamroom_testability_and_di.md`, `feedback_teamroom_plan_preexec_review.md`). Keep the filenames the same but confirm they'll live at `docs/memory/` now. No rename needed — just path change.
- [ ] Update the retro if any path needs rewriting. Keep in mind: the retro is supposed to be frozen once committed. If it's already committed by the time Task B runs, add a note at the top: "Memory file paths referenced below have moved to `docs/memory/` (see §Task-A of the closeout doc)." Do NOT rewrite the retro inline — freeze-once-committed is the rule.

### Task C — As-built pattern: skill + M1 as-built doc

- [ ] **Discovery:** determine where repo-specific skills live for this project. Check if `.claude/skills/` exists, if there's a marketplace plugin for Team Room skills, or if we invent a convention. Record the answer in this doc before proceeding.
- [ ] Create the as-built skill. Minimum content:
  - Trigger: invoked explicitly when wrapping up a significant piece of work (feature, milestone, major refactor).
  - Inputs: the relevant design doc, plan, tabled.md, retro (if any), git log for the branch, current code state.
  - Output: a single `docs/as-built/YYYY-MM-DD-<topic>.md` document.
  - Structure:
    1. What was delivered (1–2 paragraph summary)
    2. Architecture as built (processes, boundaries, files, data model, lifecycles)
    3. Key design decisions and their WHY (bulleted list; rationale preserved so future readers understand anti-regression reasoning)
    4. Adaptations during execution (pivots, plan drifts, scope changes, renamed concepts)
    5. Known limitations and debts for future work
  - Post-action: purge `docs/specs/*.md` (except `.gitkeep`) and `docs/plans/*.md` (except `.gitkeep`). Git retains history.
- [ ] Create `docs/as-built/` directory with a `.gitkeep`.
- [ ] Write `docs/as-built/2026-04-18-teamroom-m1.md` using the skill. It should consume:
  - `docs/specs/2026-04-18-teamroom-m1-design.md` (the design + post-hoc amendments)
  - `docs/plans/2026-04-18-teamroom-m1-plan.md` (for task-level history — but distilled, not copied)
  - `docs/tabled.md` (plan drifts and fixes)
  - `docs/retros/2026-04-18-m1.md` (retro decisions)
  - Git log for the branch
  - Current code state
- [ ] After as-built is committed and reviewed, purge `docs/specs/` and `docs/plans/`:
  - `git rm docs/specs/2026-04-18-teamroom-m1-design.md`
  - `git rm docs/plans/2026-04-18-teamroom-m1-plan.md`
  - Add `docs/specs/.gitkeep` and `docs/plans/.gitkeep`.
- [ ] Update `docs/ways-of-working.md` document inventory:
  - Update `docs/specs/` description to note it holds IN-FLIGHT specs only; completed ones get consumed into as-built.
  - Update `docs/plans/` description similarly.
  - Add `docs/as-built/` row with role "permanent record of shipped work; episodic + semantic; update never — frozen at close."
- [ ] Commit in two steps: (1) skill + as-built creation + inventory update; (2) purge of specs and plans.

### Task D — Split ways-of-working (procedural → skills/runbooks)

- [ ] Read current `docs/ways-of-working.md` top to bottom.
- [ ] Identify sections that are procedural (HOW to do something) vs. semantic (WHAT things are).
- [ ] For each procedural section, decide: skill, runbook, or inline-staying-put.
- [ ] Create skills for:
  - Epiphany-tabling process (could be one skill or a component of a broader reflection-rhythms skill)
  - Retro format + execution (the four-section pattern + action-item rule)
  - Promotion rule ("once is a moment, twice is a pattern") — could be a one-paragraph rule in a broader "capturing learnings" skill
  - As-built rhythm → already handled in Task C
- [ ] Leave in ways-of-working: principles, memory-type mapping, document inventory, cross-pollination, failure modes, practice-product divergence framing, promotion test for new markdown.
- [ ] Update references in ways-of-working: any place that had procedural detail now points at the skill that owns it.
- [ ] Commit.

Commit message suggestion: `docs(m1-close): split procedural ways-of-working into skills; keep semantic content in place`.

### Task E — Retro amendments + ways-of-working additions

- [ ] Add a new rhythm to ways-of-working: "Pre-execution plan review" — both Claude and user read and sanity-check the implementation plan before approving execution. Include the rationale from the retro.
- [ ] Add to failure-modes in ways-of-working: "Doc updates are part of the change that invalidates them, not a follow-up." Include a short example (M1 had drift in the root README and agent-runtime README after the LM Studio pivot).
- [ ] Add to AGENTS.md or ways-of-working: the memory-write announcement discipline from D2 (whichever location makes more sense during execution — ways-of-working if it's a working practice, AGENTS.md if it's an AI-assistant rule).
- [ ] Most of the original retro §3 "Spec amendments" list lands inside the as-built document (Task C), not as edits to the old design spec. Verify that the as-built captures: AGENTS.md / conversation.jsonl renames, TEAMROOM_MODEL_* env vars, config-and-secrets section, test-layout section, §9.1 LM Studio reality, reconciler blind spot, "credential proxy" → "model proxy" rename.
- [ ] Commit.

### Task F — CLI ergonomics (no PATH modification)

- [ ] Add an npm script to `package.json`: `"install-cli": "node scripts/install-cli.mjs"` (or similar).
- [ ] Create `scripts/install-cli.mjs`:
  - Takes an argument: the directory to install the symlink into. Parse from `process.argv`.
  - Validates the target directory exists and is writable.
  - Runs `npm run build` first (or verifies `dist/cli/main.js` exists and errors cleanly if not).
  - Creates `<target-dir>/teamroom` as a symlink to the absolute path of `dist/cli/main.js`.
  - `chmod +x` the target (the shebang in `dist/cli/main.js` needs to be correct — verify `#!/usr/bin/env node` or equivalent is present; if not, add it in `src/cli/main.ts`).
  - Prints clear output: "teamroom installed at <target>/teamroom. Ensure <target> is in your PATH."
  - Handles the edge case where a `teamroom` already exists at the target (prompt, force, or skip — make a sensible default; probably error with a clear message unless `--force` is passed).
- [ ] Update `package.json` `scripts.prepare` to run `npm run build` automatically on `npm install` — so the symlink target exists after a fresh install. (Or don't, if it slows down CI; instead have `install-cli.mjs` explicitly run it.)
- [ ] Update root `README.md` with a prominent "Install the CLI" section near the top (before or right after Quick Start). Steps:
  1. `npm install`
  2. `cp .env.example .env` + fill in LM_STUDIO_API_TOKEN (note: we don't have `.env.example` yet — create it as part of this task)
  3. `npm run build`
  4. `npm run install-cli -- <your-path-dir>` (example: `~/bin`)
  5. `teamroom status` confirms the install worked
- [ ] Create `.env.example` at repo root with `LM_STUDIO_API_TOKEN=` and any other env vars as commented-out optional knobs. Commit it (it's checked in; `.env` is not).
- [ ] Commit.

Commit message suggestion: `feat(m1-close): CLI install script with user-specified PATH directory; .env.example; README quick-start`.

### Task G — Runbooks

- [ ] Create `docs/runbooks/` directory.
- [ ] Write each runbook. Length target: 50–100 lines each. Consistent shape:
  - `# <title>`
  - One-paragraph purpose and when to use
  - `## Preconditions` — checklist
  - `## Steps` — numbered, with exact commands
  - `## Verifying success` — what to look for
  - `## Troubleshooting` — bulleted list of common failures + remedies

Specific runbooks:

- [ ] **`running-tests.md`** — `npm test` for the full suite; `npm run test:watch` for TDD; how co-located tests are discovered (glob in vitest.config.ts); integration test location; what the test count should be; interpreting failures.
- [ ] **`smoke-test.md`** — preconditions: LM Studio running on port 1234 with a model loaded, `.env` populated with `LM_STUDIO_API_TOKEN`, Docker Desktop running. Steps: `npm run build` → `docker build -t teamroom-agent-assistant:latest -f agents/assistant/Dockerfile .` → `./scripts/smoke-test.sh`. Verifying: "SMOKE PASS" + "hello back" in output. Troubleshooting: model not loaded, auth token wrong, Docker not reachable, host.docker.internal unreachable.
- [ ] **`adding-a-migration.md`** — numbering convention (NNN_description.sql, zero-padded), location (`src/db/migrations/`), how migrator picks it up on next daemon start (idempotent via `_migrations` ledger), testing it locally with `:memory:` + `runMigrations()`, how to verify it applied (`sqlite3 data/teamroom.db ".tables"` or inspect `_migrations` ledger).
- [ ] **`manual-cli-testing.md`** — start daemon in one terminal (`teamroom serve`), start tail in another (`teamroom tail`), send from a third (`teamroom send "hi"`), correlate by trace ID, inspect DB directly with `sqlite3 data/teamroom.db`, inspect log files at `data/logs/teamroom-*.jsonl`.
- [ ] **`inspecting-bus-events.md`** — `tail -f data/bus/events.jsonl` to watch events; `jq 'select(.type == "turn.errored")' data/bus/events.jsonl` for filtering; correlating event `traceId` to turn row via `sqlite3 data/teamroom.db "SELECT * FROM turns WHERE trace_id = '...'"`.
- [ ] Update `docs/ways-of-working.md` document inventory to confirm `docs/runbooks/` is described; the entry already exists but verify nothing needs tightening.
- [ ] Commit.

### Task H — Tabled cleanup

- [ ] Read `docs/tabled.md`.
- [ ] Remove all entries that have been processed by the retro + closeout execution. Specifically: plan drifts (addressed in as-built), daemon shutdown polish (captured as M2 debts in as-built), reconciler blind spot (same), `.gitignore` `.gitkeep` (fixed inline and documented in as-built or retro), Anthropic SDK type narrowing (fixed), buildDockerRunArgs env order (fixed), FileNotifyBus bugs (fixed), FSWatcher namespace (fixed).
- [ ] Keep (and polish the phrasing on):
  - **Runbook-vs-skill boundary** — now partially resolved (see §D4 in this doc). Update the entry to reflect current thinking: skills for process patterns, runbooks for specific procedures. Flag: revisit at the first agent-addition runbook to confirm the distinction holds.
  - **`@types/node` version vs runtime target** — still unresolved. Re-evaluate: is this actionable now (change package.json `@types/node` to `^20`), or still deferred? Decide and act or re-table.
- [ ] Commit.

### Task I — Verify and commit M1 close

- [ ] `npm test` — should be 68/68 passing.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — clean.
- [ ] Optionally `./scripts/smoke-test.sh` — should still pass.
- [ ] Verify `docs/specs/` is empty except `.gitkeep`. Verify `docs/plans/` is empty except `.gitkeep`. Verify `docs/as-built/2026-04-18-teamroom-m1.md` exists. Verify `docs/runbooks/` has five files. Verify `docs/memory/` has 7 files.
- [ ] Optionally roll up a final "M1 closed" commit that touches nothing but a version bump or a marker in AGENTS.md / README.

### Task J (optional) — M2 entry preparation

Not M1 close, but worth naming here so the next session knows it's coming:

- [ ] Brainstorm M2 (model proxy, reconciler blind spot, any other carry-forward work). Use the brainstorm skill. Produce a new design spec at `docs/specs/2026-XX-XX-teamroom-m2-design.md`.

---

## What's already in place (don't redo)

- Retro: `docs/retros/2026-04-18-m1.md` (committed).
- All 68 tests passing; typecheck and build clean; smoke test passing against LM Studio.
- READMEs with `## Related` convention across every multi-file module.
- `AGENTS.md` with "Navigating the codebase" section describing the README pattern.
- Tabled items captured in `docs/tabled.md` (still needs cleanup per Task H).
- Six memories written during M1 (in the old location; move them in Task A).
- One closeout item already acted on: `.gitignore` now includes `.env` and `.env.local`.

## State at closeout-doc commit time

- Branch: `single-agent`
- Latest commits (most recent first): retro + this doc → `5114992` (README convention) → `44d9d8e` (co-locate tests) → `4978b7d` (LM Studio pivot) → `d1d017e` (tabled drifts) → `a17d5b9` (module READMEs) → ... (see full `git log --oneline`)
- Tree: clean except this doc + the retro pending commit.
