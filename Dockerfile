# ── DeployBoard Orchestrator Dockerfile ────────────────────────────
# Multi-stage build for a lean production image
#
# For Docker mode (spawning build containers), the host Docker socket
# must be mounted: -v /var/run/docker.sock:/var/run/docker.sock

FROM node:20-alpine AS base

# Install git (needed for local mode cloning) + build essentials
RUN apk add --no-cache git python3 make g++

# Install pm2 globally so Node.js apps can be kept running persistently
RUN npm install -g pm2

WORKDIR /app

# ── Dependencies ────────────────────────────────────────────────────
FROM base AS deps
COPY package*.json ./
# Use npm install instead of npm ci — ci requires a package-lock.json to exist.
# If you commit your package-lock.json you can switch back to: npm ci --only=production
RUN npm install --only=production && npm cache clean --force

# ── Production image ────────────────────────────────────────────────
FROM base AS production
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Non-root user for security — create BEFORE making dirs so chown works
RUN addgroup -g 1001 -S deployboard && \
    adduser  -u 1001 -S deployboard -G deployboard

# Create directories and assign ownership to the deployboard user
# IMPORTANT: /var/www/user-sites must be owned by deployboard (uid 1001)
# so the app can write deployed sites into it without EACCES errors.
# The named volume in docker-compose will inherit this ownership.
RUN mkdir -p /var/www/user-sites /tmp/deployboard-builds && \
    chown -R deployboard:deployboard /app /var/www/user-sites /tmp/deployboard-builds && \
    chmod 755 /var/www/user-sites /tmp/deployboard-builds

USER deployboard

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "server.js"]
