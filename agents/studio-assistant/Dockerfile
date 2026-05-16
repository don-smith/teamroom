FROM oven/bun:1.3-alpine

WORKDIR /app

# Install production deps for the agent runtime directly from the Bun lockfile.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY src /app/src

ENTRYPOINT ["bun", "/app/src/agent-runtime/main.ts"]
