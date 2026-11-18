# syntax=docker/dockerfile:1
#
# Two images from one Dockerfile:
#   --target server   Node.js backend (API, MCP, providers)        -> ghcr.io/nrodemund/homeyvibe
#   --target web      Caddy serving the PWA, proxying /api and /mcp -> ghcr.io/nrodemund/homeyvibe-web
#
# Multi-arch: linux/amd64, linux/arm64 (Raspberry Pi 4/5, 64-bit OS), linux/arm/v7 (32-bit Pi OS).

ARG NODE_VERSION=22

# The web build is plain JS output, so it runs on the build machine's own arch (fast, no emulation).
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web-build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY . .
RUN npm ci --no-audit --no-fund && npm run build -w @homeyvibe/web

# Server dependencies are installed for the target arch, so native modules (if any appear later) work.
FROM node:${NODE_VERSION}-alpine AS server
WORKDIR /app
ENV NODE_ENV=production \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PORT=8080 \
    HOMEYVIBE_DATA_DIR=/data
COPY . .
RUN npm ci --omit=dev --no-audit --no-fund -w @homeyvibe/server \
    && npm cache clean --force \
    && rm -rf apps/web apps/desktop \
    && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health >/dev/null || exit 1
CMD ["node", "apps/server/src/index.js"]

FROM caddy:2-alpine AS web
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv
EXPOSE 80
