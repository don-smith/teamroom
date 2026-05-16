FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/agent-runtime /app/agent-runtime
COPY dist/types.js /app/types.js

ENTRYPOINT ["node", "/app/agent-runtime/main.js"]
