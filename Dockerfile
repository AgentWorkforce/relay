# Agent Relay Cloud - Control Plane
# Runs the Express API server with PostgreSQL/Redis connections

FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and scripts needed for postinstall
COPY package*.json ./
COPY scripts ./scripts/

# Copy workspace package.json files (required for npm workspaces to install dependencies)
COPY packages/protocol/package*.json ./packages/protocol/
COPY packages/config/package*.json ./packages/config/
COPY packages/storage/package*.json ./packages/storage/
COPY packages/state/package*.json ./packages/state/
COPY packages/policy/package*.json ./packages/policy/
COPY packages/trajectory/package*.json ./packages/trajectory/
COPY packages/telemetry/package*.json ./packages/telemetry/
COPY packages/hooks/package*.json ./packages/hooks/
COPY packages/memory/package*.json ./packages/memory/
COPY packages/utils/package*.json ./packages/utils/
COPY packages/continuity/package*.json ./packages/continuity/
COPY packages/resiliency/package*.json ./packages/resiliency/
COPY packages/user-directory/package*.json ./packages/user-directory/
COPY packages/wrapper/package*.json ./packages/wrapper/
COPY packages/bridge/package*.json ./packages/bridge/
COPY packages/cloud/package*.json ./packages/cloud/
COPY packages/daemon/package*.json ./packages/daemon/
COPY packages/sdk/package*.json ./packages/sdk/
COPY packages/api-types/package*.json ./packages/api-types/
COPY packages/spawner/package*.json ./packages/spawner/
COPY packages/mcp/package*.json ./packages/mcp/

# Install dependencies (including workspace dependencies)
RUN npm ci --include=dev

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Install dashboard from npm (for serving static files)
RUN npm install @agent-relay/dashboard

# Production image
FROM node:20-slim AS runner

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Create non-root user
RUN useradd -m -u 1001 agentrelay
USER agentrelay

# Environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start cloud server
CMD ["node", "packages/cloud/dist/index.js"]
