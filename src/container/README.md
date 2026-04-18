# `container/` — ContainerRunner seam

`ContainerRunner` abstracts the "spawn one turn, pipe stdin in, collect stdout JSONL events, capture stderr and exit code" operation. The daemon never talks to Docker directly — it goes through the interface, which makes turn processing fully testable without a real Docker daemon.

**Runs on the host in the daemon process.** The container being spawned is on the other side of the boundary — see [`agent-runtime/`](../agent-runtime/README.md) for what actually executes inside it.

## Files

- `container-runner.ts` — `ContainerRunner` interface + `ContainerStdoutEvent` discriminated union + `ContainerRunRequest`/`ContainerRunResult` types.
- `docker-command.ts` — `buildDockerRunArgs(spec)`: pure argv builder. Sorts env vars deterministically for predictable behaviour. Unit-testable in isolation.
- `docker-runner.ts` — `DockerRunner`, production impl that spawns `docker run` via `node:child_process.spawn`. Handles timeout-kill and streaming JSONL parse from stdout.
- `fake-runner.ts` — `FakeRunner`, test impl that replays a scripted event sequence per request.
- `docker-command.test.ts`, `fake-runner.test.ts` — co-located unit tests. `DockerRunner` itself has no unit tests; real `docker run` is exercised only by the smoke test.

## Related

- **Parent:** [src/README.md](../README.md)
- **Uses:** Node `child_process` (DockerRunner only).
- **Used by:** [daemon/README.md](../daemon/README.md) (turn-processor).
- **As-built:** [M1](../../docs/as-built/2026-04-18-teamroom-m1.md) — §2 container contract (mounts, env, stdin/stdout protocol, exit codes, timeouts). M2 changed the `/AGENTS.md` mount from read-only to read-write (self-improvement loops in M7 will need this); the `parseEvent` spread-order fix landed here as M1 debt #3.
