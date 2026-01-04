# CLI OAuth Flow Test Container
#
# This container simulates the AI provider CLIs for testing
# the OAuth URL capture flow without actual provider accounts.
#
# Usage:
#   docker build -t cli-oauth-test scripts/test-cli-auth/
#   docker run --rm cli-oauth-test
#
# For interactive testing:
#   docker run --rm -it cli-oauth-test bash
#   claude  # Run mock Claude CLI
#   codex login  # Run mock Codex CLI

FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy mock CLI script
COPY mock-cli.sh /usr/local/bin/mock-cli
RUN chmod +x /usr/local/bin/mock-cli

# Create symlinks for each provider CLI
# The mock-cli.sh auto-detects the provider from $0
RUN ln -s /usr/local/bin/mock-cli /usr/local/bin/claude && \
    ln -s /usr/local/bin/mock-cli /usr/local/bin/codex && \
    ln -s /usr/local/bin/mock-cli /usr/local/bin/gemini && \
    ln -s /usr/local/bin/mock-cli /usr/local/bin/opencode && \
    ln -s /usr/local/bin/mock-cli /usr/local/bin/droid

# Copy test files
COPY ci-test-runner.ts /app/
COPY package.json /app/

# Install test dependencies
RUN npm install

# Default command runs the CI tests
CMD ["npx", "tsx", "/app/ci-test-runner.ts"]
