# `cli/` — `teamroom` binary

Thin. Each subcommand is a file that parses its arguments and delegates to a service function. Logic does not live here — it lives behind DI-friendly services in `src/db/`, `src/bus/`, etc. No direct unit tests for the commander wiring; per-command tests exercise the underlying service functions.

Commands: `serve`, `send`, `tail`, `status`.
