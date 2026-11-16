FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --include=dev --no-audit --no-fund --fetch-retries=5 --fetch-timeout=120000

COPY src ./src
COPY sql ./sql
COPY web ./web
COPY vite.config.js ./
RUN npm run build && npm prune --omit=dev && npm run check

EXPOSE 3000
CMD ["node", "src/server.js"]
