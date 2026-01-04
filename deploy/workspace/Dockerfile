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

# Install dependencies (production only, skip tmux in CI)
ENV CI=true
RUN npm ci --omit=dev

# Copy pre-built dist (build before docker build)
COPY dist ./dist

# ---

FROM node:20-slim

WORKDIR /app

# Install system dependencies for AI CLIs and git
# Note: tmux not needed - daemon uses node-pty directly
RUN apt-get update && apt-get install -y \
    bash \
    ca-certificates \
    curl \
    git \
    python3 \
    jq \
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
COPY deploy/workspace/entrypoint.sh /entrypoint.sh
COPY deploy/workspace/git-credential-relay /usr/local/bin/git-credential-relay
RUN chmod +x /entrypoint.sh /usr/local/bin/git-credential-relay

# Install npm-based CLIs globally as root (npm -g requires root)
RUN npm install -g @openai/codex
RUN npm install -g @google/gemini-cli
RUN npm install -g opencode-ai@latest

# Create workspace directory
RUN mkdir -p /workspace/repos /data

# Create non-root user
RUN useradd -m -u 1001 workspace
RUN chown -R workspace:workspace /app /workspace /data
USER workspace

# Install AI CLIs as workspace user (they install to ~/.local/bin)
# Claude
RUN curl -fsSL https://claude.ai/install.sh | bash
# Pre-seed Claude config to skip interactive onboarding
RUN mkdir -p /home/workspace/.claude && \
    echo '{"theme":"dark","hasCompletedOnboarding":true}' > /home/workspace/.claude/settings.local.json
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
