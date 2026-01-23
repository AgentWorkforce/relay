# Agent Relay Workspace
# Uses pre-built base image with CLI tools for faster builds

# Build stage - compile TypeScript
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and scripts (needed for postinstall)
COPY package*.json ./
COPY scripts ./scripts

# Copy workspace package.json files (required for npm workspaces to install dependencies)
COPY packages/protocol/package*.json ./packages/protocol/
COPY packages/config/package*.json ./packages/config/
COPY packages/storage/package*.json ./packages/storage/
COPY packages/state/package*.json ./packages/state/
COPY packages/policy/package*.json ./packages/policy/
COPY packages/trajectory/package*.json ./packages/trajectory/
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
COPY packages/dashboard/package*.json ./packages/dashboard/
COPY packages/dashboard-server/package*.json ./packages/dashboard-server/

# Install ALL dependencies (need devDependencies for build)
ENV CI=true
RUN npm ci

# Copy source files for build
COPY tsconfig*.json ./
COPY src ./src
COPY packages ./packages

# Build all packages and root TypeScript (skip dashboard build for workspace image)
RUN npm run build:workspace

# Remove devDependencies after build
RUN npm prune --omit=dev

# ---
# Runtime stage - use pre-built base with all CLIs
FROM ghcr.io/agentworkforce/relay-workspace-base:latest

WORKDIR /app

# Copy from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages ./packages
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
RUN ln -sf /app/dist/src/cli/index.js /usr/local/bin/agent-relay && \
    chmod +x /app/dist/src/cli/index.js 2>/dev/null || true

# Fix ownership
RUN chown -R workspace:workspace /app

# === MCP Server for Agent Relay ===
# Pre-configure MCP so all CLI tools have relay tools available

# Configure Claude Code MCP settings (global config is ~/.claude.json)
RUN echo '{"mcpServers":{"agent-relay":{"command":"node","args":["/app/dist/src/cli/index.js","mcp","serve"]}}}' \
    > /home/workspace/.claude.json && \
    chown workspace:workspace /home/workspace/.claude.json

# Configure Cursor MCP settings
RUN mkdir -p /home/workspace/.cursor && \
    echo '{"mcpServers":{"agent-relay":{"command":"node","args":["/app/dist/src/cli/index.js","mcp","serve"]}}}' \
    > /home/workspace/.cursor/mcp.json && \
    chown -R workspace:workspace /home/workspace/.cursor

# Configure Gemini CLI MCP settings
RUN mkdir -p /home/workspace/.gemini && \
    echo '{"mcpServers":{"agent-relay":{"command":"node","args":["/app/dist/src/cli/index.js","mcp","serve"]}}}' \
    > /home/workspace/.gemini/settings.json && \
    chown -R workspace:workspace /home/workspace/.gemini

# Configure OpenCode MCP settings (uses "mcp" key, not "mcpServers")
RUN mkdir -p /home/workspace/.config/opencode && \
    echo '{"mcp":{"agent-relay":{"command":"node","args":["/app/dist/src/cli/index.js","mcp","serve"]}}}' \
    > /home/workspace/.config/opencode/opencode.json && \
    chown -R workspace:workspace /home/workspace/.config/opencode

# Configure Droid (Factory) MCP settings
RUN mkdir -p /home/workspace/.factory && \
    echo '{"mcpServers":{"agent-relay":{"command":"node","args":["/app/dist/src/cli/index.js","mcp","serve"]}}}' \
    > /home/workspace/.factory/mcp.json && \
    chown -R workspace:workspace /home/workspace/.factory

# Run entrypoint as root so it can start sshd; entrypoint drops to workspace via gosu
USER root

# Environment
ENV NODE_ENV=production
# MCP socket discovery uses RELAY_PROJECT to find the daemon socket
# Default value set here; entrypoint overrides with WORKSPACE_ID if set at runtime
ENV RELAY_PROJECT=default
ENV PORT=3888
ENV AGENT_RELAY_DATA_DIR=/data
ENV AGENT_RELAY_DASHBOARD_PORT=3888
ENV PATH="/home/workspace/.local/bin:$PATH"

# Expose ports
# 3888: Dashboard/API, 3889: Daemon, 1455: Codex OAuth callback, 3022: SSH (for tunneling)
EXPOSE 3888 3889 1455 3022

# Volume for persistent data
VOLUME ["/data", "/workspace"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3888/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["/entrypoint.sh"]
