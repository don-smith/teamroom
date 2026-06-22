# Memory Index

> **What this is.** The session-start bias layer. Entries here are auto-loaded
> into every conversation, so they need to belong in working context *before*
> the user states a request. Each entry carries the WHY (user quote, incident,
> reasoning) so I can extrapolate to edge cases rather than pattern-match a
> bullet.
>
> **What this is not.** Process content (→ imported workflow skill packages).
> Procedures (→ `docs/runbooks/`). Tactical capabilities (→ imported workflow skill packages such as `@juicesharp/rpiv-pi` and `@locksmithdon/dons-flow`).
> Anything derivable from current code or docs. Conversation-scoped state
> (→ plans / tasks).
>
> **Decision rule.** Does future Claude need this loaded *before* knowing the
> user's request? If no, it belongs in a different layer.
>
> **Pruning rhythm.** Reviewed at every milestone close. Anything that's drifted
> stale, become process content, or stopped earning its keep is removed —
> consult the milestone retro for what was decided.

- [Team Room — Libby owns MyFlow stages 1 and 5](project_teamroom_libby_stage_owner.md) — Libby (librarian) is the current owner of Stage 1: Discover & Align and Stage 5: Land & Learn; Hisa the historian is a future rename decision, not current reality
- [Team Room — agent runtime changes require live manual verification](project_teamroom_live_validation_required.md) — unit tests are not sufficient for container mounts, skill prompts, mail tools, daemon startup, or chat UX — run smoke test before closeout
- [Team Room — runtime hardening: bounded cleanup, actionable CLI errors](project_teamroom_runtime_hardening_pattern.md) — best-effort startup operations must be bounded with timeouts, log failures loudly, and never silently block; interactive CLIs must preflight connectivity

## Feedback
- [Team Room — minimize long-running process dependencies](feedback_teamroom_minimize_process_deps.md) — prefer in-process/embedded deps over separate long-running services
- [Team Room — see only as far as needed, not further](feedback_teamroom_see_only_as_far_as_needed.md) — defer formalization and abstraction until a concrete second example forces the shape
- [Team Room — design for testability via DI, not mocks](feedback_teamroom_testability_and_di.md) — every effectful dep behind an interface, in-memory real impls for tests, no mock libraries
- [Team Room — deliberate coupling and extensibility](feedback_teamroom_coupling_and_extensibility.md) — what's shared vs. isolated is a first-class architectural concern at every decision point
- [Team Room — build it with the team practices we want Team Room to produce](feedback_teamroom_meta_consistency.md) — read docs/ways-of-working.md; apply reflection, retros, and deliberate docs to our own development
- [Team Room — no skipped tests; pass means full E2E success](feedback_teamroom_no_skipped_tests.md) — integration tests run on every npm test, no opt-in gates; "passing" requires the full success criterion, never an intermediate signal like "auth accepted but rate-limited"
- [Team Room — no failing tests before moving on, ever](feedback_teamroom_no_failing_tests.md) — any test failure is a hard stop on all downstream work (milestone close, brainstorms, planning); never categorise as "environmental" before investigating
- [Team Room — best up-front architecture, graceful flexibility when implementation reveals gaps](feedback_teamroom_flexibility_on_discovery.md) — up-front design is first-order; pivot gracefully when implementation exposes a gap; don't lean on flexibility as a pass on design work
- [Team Room — integration harnesses and prod composition must share their wiring shape](feedback_teamroom_composition_parity.md) — extract a shared builder or add a composition-snapshot test so test-green ≠ prod-green gaps can't hide
- [Team Room — default to the reference SDK when implementing a third-party protocol](feedback_teamroom_protocol_sdk_default.md) — MCP, OAuth, etc. — protocols drift; SDKs absorb the drift; hand-roll only with a documented blocker-grade reason

## Project
- [Team Room — DeepAgents and Pi are the primary agent runtimes](project_teamroom_primary_runtimes.md) — DeepAgents (Python, filesystem+tools, persistent) and Pi (TypeScript, coding SDK) are the two primary runtimes; the container contract is language-agnostic and runtime-opaque
- [Team Room — NanoClaw is the design reference for container + credential patterns](project_teamroom_nanoclaw_reference.md) — qwibitai/nanoclaw on GitHub; M2's OAuth pivot was modeled directly on it
- [Team Room — OpenRouter is the sole provider backbone](project_teamroom_provider_openrouter.md) — OpenRouter consolidation completed during persona realignment; all agents route through OpenRouter; LM Studio, Ollama, OpenAI, and Anthropic direct-access providers have been removed
- [Team Room — pi-mcp-adapter is available for MCP integration](project_teamroom_pi_mcp_adapter.md) — pi-mcp-adapter v2.10.0 (nicopreme) is installed as a dependency; not yet wired into the SDK agent sessions, but available for future MCP server integration work
