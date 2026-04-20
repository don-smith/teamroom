FROM node:22-alpine

WORKDIR /app

# Install production deps for the agent runtime (must match repo package.json,
# which includes @anthropic-ai/claude-agent-sdk as a dep).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install the Claude Code CLI globally — claude-agent-sdk's `query()` spawns
# this binary as a subprocess to talk to Anthropic.
RUN npm install -g @anthropic-ai/claude-code

COPY dist/agent-runtime /app/agent-runtime
COPY dist/types.js /app/types.js

ENTRYPOINT ["node", "/app/agent-runtime/main.js"]
