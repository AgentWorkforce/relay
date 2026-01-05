# Agent Relay Workspace
# Runs a user's workspace with the relay daemon and agent orchestration

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

FROM node:20-slim

WORKDIR /app

# Install system dependencies for AI CLIs and git
# Note: tmux not needed - daemon uses node-pty directly
# gosu is used to drop privileges from root to workspace user
# Build tools (make, g++) needed for agents to npm install repos with native modules
RUN apt-get update && apt-get install -y \
    bash \
    ca-certificates \
    curl \
    git \
    python3 \
    jq \
    gosu \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (gh)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Copy from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy docs folder (contains relay snippets for agent spawning)
COPY docs ./docs

COPY deploy/workspace/entrypoint.sh /entrypoint.sh
COPY deploy/workspace/git-credential-relay /usr/local/bin/git-credential-relay
RUN chmod +x /entrypoint.sh /usr/local/bin/git-credential-relay

# Install npm-based CLIs globally as root (npm -g requires root)
RUN npm install -g @openai/codex
RUN npm install -g @google/gemini-cli
RUN npm install -g opencode-ai@latest

# Create symlink for agent-relay CLI (for debugging inside container)
# The actual CLI is built as part of the app
RUN ln -sf /app/dist/cli/index.js /usr/local/bin/agent-relay && \
    chmod +x /app/dist/cli/index.js 2>/dev/null || true

# Create workspace directory
RUN mkdir -p /workspace /data

# Create non-root user
RUN useradd -m -u 1001 -s /bin/bash workspace \
    && chown -R workspace:workspace /app /workspace /data

USER workspace

# Install AI CLIs as workspace user (they install to ~/.local/bin)
# Claude
RUN curl -fsSL https://claude.ai/install.sh | bash
# Note: We don't pre-seed Claude config - we want the full interactive auth flow
# to run so the PTY runner can capture the auth URL
# Note: Codex, Gemini, and OpenCode are installed as root above via npm
# Droid
RUN curl -fsSL https://app.factory.ai/cli | sh

# Environment
ENV NODE_ENV=production
ENV PORT=3888
ENV AGENT_RELAY_DATA_DIR=/data
ENV AGENT_RELAY_DASHBOARD_PORT=3888
ENV PATH="/home/workspace/.local/bin:$PATH"

# Expose ports
# 3888 - Dashboard/API
# 3889 - WebSocket (optional)
EXPOSE 3888 3889

# Volume for persistent data
VOLUME ["/data", "/workspace"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3888/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["/entrypoint.sh"]
