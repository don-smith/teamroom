# Memory Index

> **What this is.** The session-start bias layer. Entries here are auto-loaded
> into every conversation, so they need to belong in working context *before*
> the user states a request. Each entry carries the WHY (user quote, incident,
> reasoning) so I can extrapolate to edge cases rather than pattern-match a
> bullet.
>
> **What this is not.** Process content (→ `docs/ways-of-working.md`).
> Procedures (→ `docs/runbooks/`). Tactical capabilities (→ `.claude/skills/`).
> Anything derivable from current code or docs. Conversation-scoped state
> (→ plans / tasks).
>
> **Decision rule.** Does future Claude need this loaded *before* knowing the
> user's request? If no, it belongs in a different layer.
>
> **Pruning rhythm.** Reviewed at every milestone close. Anything that's drifted
> stale, become process content, or stopped earning its keep is removed —
> consult the milestone retro for what was decided.

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
- [Team Room — LangGraph is the intended per-agent runtime](project_teamroom_langgraph_direction.md) — agents will run LangGraph workflows eventually; M1 keeps the runtime simple but the container contract is language-agnostic to accommodate it
- [Team Room — NanoClaw is the design reference for container + credential patterns](project_teamroom_nanoclaw_reference.md) — qwibitai/nanoclaw on GitHub; M2's OAuth pivot was modeled directly on it
- [Team Room — Anthropic auth defaults to OAuth via Claude Code subscription](project_teamroom_anthropic_oauth_default.md) — claude-agent-sdk in container, host proxy substitution; API key is fallback only
