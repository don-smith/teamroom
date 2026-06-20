# MyFlow Agent Onboarding — skills, stage roles, and resilient startup

## Quick Reference
- **Date:** 2026-06-20
- **Key files:** `src/daemon/daemon.ts`, `src/agent-spec/build-spec.ts`, `src/agent-runtime/pi-worker.ts`, `src/container/kill-stale.ts`, `src/cli/chat.ts`, `agents/{archie,libby,micah,doc}/AGENTS.md`, `agents/{archie,libby}/shim.py`, `.env.example`, `package.json`
- **Key concepts:** myflow-skills-mount, stage-ownership, progressive-disclosure, deepagents-mail-fallback, bounded-docker-cleanup
- **One-line summary:** Team Room agents now know their MyFlow stage roles, can read mounted MyFlow skills from `/myflow-skills`, and have hardened startup/chat behavior for live onboarding.

## How It Works Now

### MyFlow skills mount

The daemon reads `TEAMROOM_MYFLOW_PATH` at startup in `src/daemon/daemon.ts`. When set, it validates `<TEAMROOM_MYFLOW_PATH>/skills` and passes that host directory into `buildSpec()` as `myflowSkillsPath`. `src/agent-spec/build-spec.ts` mounts it into every agent container at `/myflow-skills` with `readOnly: true`.

If `TEAMROOM_MYFLOW_PATH` is unset, the daemon logs that the MyFlow skills mount is skipped and agents run with the previous behavior. If the variable is set but `<path>/skills` does not exist, startup fails loudly.

`.env.example` documents the setting, and `package.json` provides `bun run dev` / `bun run cli:serve` wrappers that set `TEAMROOM_CODEBASE_PATH="$PWD"` so DeepAgents containers receive the working tree at `/codebase`.

### Pi runtime skill registration

Pi agents — Micah and Doc — load MyFlow skills through the Pi SDK in `src/agent-runtime/pi-worker.ts`:

- detect `/myflow-skills`
- call `loadSkillsFromDir({ dir: "/myflow-skills", source: "myflow" })`
- log SDK diagnostics to stderr
- call `formatSkillsForPrompt(skills)`
- pass `/myflow-skills` through `DefaultResourceLoader.additionalSkillPaths`
- append the formatted progressive-disclosure skill prompt to the Team Room system prompt

The `existsSync("/myflow-skills")` guard keeps Pi startup safe when the mount is absent.

### DeepAgents skill references

DeepAgents agents — Libby and Archie — do not use the Pi SDK. Their AGENTS.md files list compact MyFlow skill references and instruct them to read `/myflow-skills/<name>/SKILL.md` when a task matches. This keeps prompts small while preserving progressive disclosure.

DeepAgents use `FilesystemBackend(root_dir="/codebase", virtual_mode=False)`. With `virtual_mode=False`, absolute paths are available, so `/myflow-skills/...` can be read even though the backend root is `/codebase`.

### Stage ownership

Each agent's AGENTS.md now states its MyFlow stage responsibilities:

| Agent | Runtime | MyFlow responsibility |
|---|---|---|
| Libby | DeepAgents | Stage 1: Discover & Align, Stage 5: Land & Learn |
| Archie | DeepAgents | Stage 2: Research & Design |
| Micah | Pi | Stage 3: Implement |
| Doc | Pi | Stage 4: Validate & Review |

Each AGENTS.md also documents the team roster, `/store/memory.md`, and self-improvement through writable `/AGENTS.md`.

### DeepAgents mail reply resilience

`agents/archie/shim.py` and `agents/libby/shim.py` raise the default per-wake recursion limit to 50. This prevents ordinary MyFlow onboarding turns from exhausting the previous lower budget.

Both shims also recover from malformed long `mail_reply` tool-call JSON. When the model emits invalid args such as an unterminated `{"body": "...` payload, the shim extracts the intended body and sends a direct MCP HTTP `tools/call` request for `mail.reply` using `json=request`, letting the HTTP client serialize the body safely.

Archie records structured diagnostics for invalid tool calls and fallback use. Libby uses the delivered `messageId` for fallback `mail.reply`; this matters because the MCP tool expects a message id, not a thread id.

### Startup and chat ergonomics

`src/container/kill-stale.ts` bounds real Docker cleanup with a 3s timeout. If `docker ps --filter label=teamroom-agent=true` hangs or Docker Desktop is unhealthy, startup logs `kill-stale.list-failed` and continues. Tests inject a no-op stale-container killer through `DaemonOptions.staleContainerKiller` so daemon composition tests do not depend on real Docker.

`src/cli/chat.ts` preflights TCP reachability before constructing a WebSocket. When stale `data/ports/chat.port` points at a dead daemon, the CLI reports:

```text
chat server unavailable on 127.0.0.1:<port> — is the daemon running?
```

instead of crashing with a raw WebSocket `ErrorEvent`.

## Key Decisions

### Mount skills instead of copying them into images

**What:** MyFlow skills are mounted read-only from `<TEAMROOM_MYFLOW_PATH>/skills` to `/myflow-skills`.

**Why:** Skill updates do not require rebuilding agent images, and the shared skill library remains immutable from inside Team Room containers.

**Regression risk:** medium

**Rejected alternative:** Copy skills into Docker images.

**Why rejected:** It would couple process changes to image rebuilds and make local MyFlow iteration slower.

### Use Pi SDK skill primitives for Pi agents

**What:** Pi agents use `loadSkillsFromDir`, `formatSkillsForPrompt`, and `DefaultResourceLoader.additionalSkillPaths`.

**Why:** The SDK already owns skill discovery and prompt formatting. Duplicating that logic in Team Room would be drift-prone.

**Regression risk:** medium

**Rejected alternative:** Hand-roll skill scanning or paste skill descriptions into Micah/Doc AGENTS.md.

**Why rejected:** It would duplicate SDK behavior and increase prompt size.

### Use compact AGENTS.md references for DeepAgents

**What:** Libby and Archie list skill names and short purposes in AGENTS.md, pointing to `/myflow-skills/<name>/SKILL.md` for full instructions.

**Why:** DeepAgents lacks Pi's native skill loader. Compact references give the model enough routing context without embedding bulky skill bodies.

**Regression risk:** medium

**Rejected alternative:** Full XML skill blocks or full skill bodies in AGENTS.md.

**Why rejected:** The verbose version made AGENTS.md too large and harder to maintain.

### Split MyFlow stages by agent role

**What:** Libby owns stages 1 and 5, Archie owns stage 2, Micah owns stage 3, and Doc owns stage 4.

**Why:** The mapping follows existing personas: librarian for intake/closeout, architect for design, mechanic for implementation, doctor for validation.

**Regression risk:** low

### Bound Docker stale cleanup

**What:** Real Docker cleanup has a 3s timeout; daemon tests inject a no-op cleanup function.

**Why:** Stale-container cleanup is best-effort. It must not prevent the daemon from starting when Docker Desktop is unhealthy or `docker ps` hangs.

**Regression risk:** medium

**Rejected alternative:** Let Docker cleanup block startup indefinitely.

**Why rejected:** Live validation showed this creates a silent startup hang, stale port files, and confusing chat failures.

## Constraints & Gotchas

- `TEAMROOM_MYFLOW_PATH` must point to the MyFlow repo root; Team Room derives `<path>/skills` itself.
- `.env` may contain secrets and is gitignored; do not print or commit it.
- DeepAgents runtime fixes require rebuilt agent images and a restarted daemon before running containers pick them up.
- `data/ports/*.port` can be stale if a daemon is killed uncleanly. The chat CLI now reports this clearly, but restarting `bun run dev` is still required.
- Do not start `bun run dev` as a long-running background process from automation that may kill stdout/stderr; use a real terminal.
- The MyFlow design and validation artifacts live under `.myflow/artifacts/` as local process artifacts. This as-built document is the durable repo-level reference.

## Background Context

Team Room already had four persona agents and two primary runtimes, but those agents did not know the MyFlow process, could not load MyFlow skills, and lacked a clear self-improvement/memory protocol. This branch onboarded MyFlow into the runtime contract and agent prompts, then validated the behavior with live Archie and Libby conversations. During live validation, two operational hardening issues surfaced — Docker cleanup could hang daemon startup, and stale chat ports produced poor CLI errors — so those fixes shipped as part of the same closeout.
