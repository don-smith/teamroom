# Alpine's musl base leaves Bun's global `claude` symlink pointing at the
# glibc binary, which does not exec at runtime. Use the official glibc image
# for the Claude workers only.
FROM oven/bun:1.3

WORKDIR /app

# Install production deps for the agent runtime (must match repo package.json,
# which includes @anthropic-ai/claude-agent-sdk as a dep).
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Install the Claude Code CLI globally — claude-agent-sdk's `query()` spawns
# this binary as a subprocess to talk to Anthropic. Required for the
# OAuth-via-subscription path; without it, the SDK has no executable to spawn.
# (Same pattern as NanoClaw's container Dockerfile.)
RUN bun install -g @anthropic-ai/claude-code

COPY src /app/src

ENTRYPOINT ["bun", "/app/src/agent-runtime/main.ts"]
