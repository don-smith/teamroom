# Memory Index

## Feedback
- [Team Room — minimize long-running process dependencies](feedback_teamroom_minimize_process_deps.md) — prefer in-process/embedded deps over separate long-running services
- [Team Room — see only as far as needed, not further](feedback_teamroom_see_only_as_far_as_needed.md) — defer formalization and abstraction until a concrete second example forces the shape
- [Team Room — design for testability via DI, not mocks](feedback_teamroom_testability_and_di.md) — every effectful dep behind an interface, in-memory real impls for tests, no mock libraries
- [Team Room — deliberate coupling and extensibility](feedback_teamroom_coupling_and_extensibility.md) — what's shared vs. isolated is a first-class architectural concern at every decision point
- [Team Room — build it with the team practices we want Team Room to produce](feedback_teamroom_meta_consistency.md) — read docs/ways-of-working.md; apply reflection, retros, and deliberate docs to our own development

## Project
- [Team Room — LangGraph is the intended per-agent runtime](project_teamroom_langgraph_direction.md) — agents will run LangGraph workflows eventually; M1 keeps the runtime simple but the container contract is language-agnostic to accommodate it
