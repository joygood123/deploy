# ── DeployBoard Orchestrator Dockerfile ────────────────────────────
# Multi-stage build for a lean production image
#
# For Docker mode (spawning build containers), the host Docker socket
# must be mounted: -v /var/run/docker.sock:/var/run/docker.sock

FROM node:20-alpine AS base

# Install git (needed for local mode cloning)
RUN apk add --no-cache git

WORKDIR /app

# ── Dependencies ────────────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# ── Production image ────────────────────────────────────────────────
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Create default directories (may be overridden by volume mounts)
RUN mkdir -p /var/www/user-sites /tmp/deployboard-builds

# Non-root user for security
RUN addgroup -g 1001 -S deployboard && \
    adduser  -u 1001 -S deployboard -G deployboard
RUN chown -R deployboard:deployboard /app /var/www/user-sites /tmp/deployboard-builds
USER deployboard

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "server.js"]
