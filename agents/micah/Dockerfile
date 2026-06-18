FROM oven/bun:1.3

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY src /app/src

ENTRYPOINT ["bun", "/app/src/agent-runtime/main.ts"]
