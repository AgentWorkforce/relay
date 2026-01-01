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
COPY src/dashboard/package*.json ./src/dashboard/
COPY scripts ./scripts/

# Install dependencies
RUN npm ci --include=dev

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Build dashboard
RUN cd src/dashboard && npm ci && npm run build

# Production image
FROM node:20-slim AS runner

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/dashboard/out ./src/dashboard/out
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
CMD ["node", "dist/cloud/index.js"]
