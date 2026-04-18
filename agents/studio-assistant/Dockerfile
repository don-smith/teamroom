FROM node:20-alpine

WORKDIR /app

# Install production deps for the agent runtime (must match repo package.json).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled agent-runtime from dist/.
COPY dist/agent-runtime /app/agent-runtime
COPY dist/types.js /app/types.js

ENTRYPOINT ["node", "/app/agent-runtime/main.js"]
