# Agent Relay Workspace
# Uses pre-built base image with CLI tools for faster builds

# Build stage - compile TypeScript
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (node-pty, better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and scripts (needed for postinstall)
COPY package*.json ./
COPY scripts ./scripts

# Install ALL dependencies (need devDependencies for build)
ENV CI=true
RUN npm ci

# Copy source files for build
COPY tsconfig*.json ./
COPY src ./src

# Build the TypeScript (skip dashboard build for workspace image)
RUN npx tsc

# Remove devDependencies after build
RUN npm prune --omit=dev

# ---
# Runtime stage - use pre-built base with all CLIs
FROM ghcr.io/agentworkforce/relay-workspace-base:latest

WORKDIR /app

# Copy from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy relay snippets for agent spawning (only what's needed)
COPY docs/agent-relay-snippet.md docs/agent-relay-protocol.md docs/agent-policy-snippet.md ./docs/

# Copy workspace configuration files
COPY deploy/workspace/entrypoint.sh /entrypoint.sh
COPY deploy/workspace/codex.config.toml ./deploy/workspace/codex.config.toml
COPY deploy/workspace/git-credential-relay /usr/local/bin/git-credential-relay
COPY deploy/workspace/gh-relay /usr/local/bin/gh
RUN chmod +x /entrypoint.sh /usr/local/bin/git-credential-relay /usr/local/bin/gh

# Create symlink for agent-relay CLI
RUN ln -sf /app/dist/cli/index.js /usr/local/bin/agent-relay && \
    chmod +x /app/dist/cli/index.js 2>/dev/null || true

# Fix ownership
RUN chown -R workspace:workspace /app

# Run entrypoint as root so it can start sshd; entrypoint drops to workspace via gosu
USER root

# Environment
ENV NODE_ENV=production
ENV PORT=3888
ENV AGENT_RELAY_DATA_DIR=/data
ENV AGENT_RELAY_DASHBOARD_PORT=3888
ENV PATH="/home/workspace/.local/bin:$PATH"

# Expose ports
# 3888: Dashboard/API, 3889: Daemon, 1455: Codex OAuth callback, 2222: SSH (for tunneling)
EXPOSE 3888 3889 1455 2222

# Volume for persistent data
VOLUME ["/data", "/workspace"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3888/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["/entrypoint.sh"]
