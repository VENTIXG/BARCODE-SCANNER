# Warehouse IMS server image: API + web app, one process, data in /data.
# Build:  docker build -t warehouse-ims:dev .
# Multi-architecture (what the release workflow does):
#   docker buildx build --platform linux/amd64,linux/arm64 .
# The JavaScript build runs once on the build machine: better-sqlite3 ships ready-made
# binaries for every platform, so node_modules is the same for x86_64 and arm64.
# The image contains no secrets; configuration comes from the environment.

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Production dependencies only (no test or build tools).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /out/data

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data \
    TRUST_PROXY=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
COPY --from=deps --chown=node:node /out/data /data
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/dist/index.js"]
