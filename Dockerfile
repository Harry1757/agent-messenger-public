FROM node:22-slim AS package
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY daemon ./daemon
COPY shared ./shared
COPY scripts ./scripts
COPY docs/설치.md ./docs/설치.md
RUN node --experimental-strip-types scripts/package-daemon.ts

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared ./shared
COPY server ./server
COPY web ./web
COPY --from=package /app/web/downloads ./web/downloads

ENV DB_PATH=/data/messenger.db
ENV PORT=3000
EXPOSE 3000

CMD ["node", "--experimental-strip-types", "--experimental-sqlite", "--disable-warning=ExperimentalWarning", "server/main.ts"]
