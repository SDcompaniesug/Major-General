FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Baileys pulls a Git-hosted dependency and some packages may need native builds.
# The slim Node image does not include git or the native build toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --fetch-retries=5 --fetch-timeout=120000

COPY src ./src
COPY sql ./sql
RUN npm run check

EXPOSE 3000
CMD ["node", "src/server.js"]
