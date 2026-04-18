# `container/` — ContainerRunner seam

`ContainerRunner` abstracts the "spawn one turn, collect events, exit" operation. `DockerRunner` spawns real `docker run`; `FakeRunner` replays scripted events for tests. `docker-command.ts` is a pure argv builder — the unit-testable portion of the real runner.

The agent container's contract (mounts, env, stdin/stdout JSONL protocol) is specified in `docs/specs/2026-04-18-teamroom-m1-design.md` §9.
