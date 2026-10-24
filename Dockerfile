# Private mope.io server for Railway (or any Docker host).
# Build: fetches mope.io's client and patches it for this server (bun run setup).
# Run:   bun server.js on $PORT; accounts and downloaded assets live on the volume at /data, or
#        accounts and records in Postgres when DATABASE_URL is set.
FROM node:22-bookworm-slim

WORKDIR /app
RUN npm install -g bun@1.4.2

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run setup

ENV NODE_ENV=production \
    DATA_DIR=/data \
    ASSETS_DIR=/data/assets
CMD ["bun", "server.js"]
