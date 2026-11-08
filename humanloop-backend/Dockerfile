# Build from the repository root: docker build -f humanloop-backend/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /app/humanloop-backend
COPY humanloop-backend/package*.json ./
RUN npm ci
COPY humanloop-backend/index.html humanloop-backend/vite.config.mjs humanloop-backend/tsconfig.json ./
COPY humanloop-backend/web ./web
COPY humanloop-backend/config ./config
COPY humanloop-backend/scripts ./scripts
RUN npm run prepare:audio && npm run typecheck && npm run build
WORKDIR /app/humanloop
COPY humanloop/package*.json ./
RUN npm ci
COPY humanloop/index.html humanloop/vite.config.ts humanloop/tsconfig.json ./
COPY humanloop/src ./src
COPY humanloop/scripts ./scripts
COPY humanloop/public ./public
RUN npm run build
WORKDIR /app/humanloop-backend
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends awscli python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY requirements-agentprint.txt /tmp/requirements-agentprint.txt
RUN python3 -m venv /app/.venv-agentprint && /app/.venv-agentprint/bin/python -m pip install --no-cache-dir -r /tmp/requirements-agentprint.txt
COPY hospiceprint /app/hospiceprint
WORKDIR /app/humanloop-backend
COPY --from=build /app/humanloop-backend/node_modules ./node_modules
COPY --from=build /app/humanloop-backend/dist ./dist
COPY --from=build /app/humanloop/dist /app/humanloop/dist
COPY humanloop-backend/package*.json ./
COPY humanloop-backend/server ./server
COPY humanloop-backend/scripts ./scripts
COPY humanloop-backend/config ./config
RUN chown node:node /app/humanloop-backend
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 CAREALONG_WEB_ROOT=/app/humanloop/dist
USER node
EXPOSE 8080
# Mount cloud configuration and demo login secrets read-only at runtime.
# Persist the private AgentPrint key file securely between container replacements.
# Supply temporary AWS credentials or an IAM role at runtime; no keys are baked in.
CMD ["node", "scripts/start.mjs"]
