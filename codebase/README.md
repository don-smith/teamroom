# /codebase — shared work area

This directory is mounted read-write at `/codebase` in every agent container. It represents the codebase the team is managing. In this repo it's a sample for the M3 demo; eventually it will point at any target codebase the operator chooses (via `TEAMROOM_CODEBASE_PATH` env var).

Agents with filesystem tools (like `claude-assistant` as of M3) can read and write files here. Agents without tools (like `studio-assistant` today) still get the mount passively — ready for when they grow capability.

The harness itself does not modify this directory.

## Sample structure

- `main`: the main branch
- `worktrees`: the parent folder of all worktrees/branches
