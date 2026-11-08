FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.mjs tsconfig.json ./
COPY web ./web
COPY public ./public
COPY config ./config
COPY scripts/prepare-audio-assets.mjs ./scripts/prepare-audio-assets.mjs
RUN npm run prepare:audio
RUN npm run typecheck && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends awscli && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
COPY server ./server
COPY scripts ./scripts
COPY config ./config
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
# Mount .carealong-cloud.json and .carealong-secrets.json read-only at runtime.
# Supply temporary AWS credentials through the runtime environment or an IAM role.
CMD ["node", "scripts/start.mjs"]
