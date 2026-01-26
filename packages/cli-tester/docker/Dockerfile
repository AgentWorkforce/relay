# CLI Auth Tester - Manual interactive testing environment
# Based on relay-workspace which has all CLIs pre-installed
#
# Build the base image first if needed:
#   docker build -f deploy/workspace/Dockerfile.local -t relay-workspace:local .

ARG BASE_IMAGE=relay-workspace:local
FROM ${BASE_IMAGE}

# Switch to root for setup
USER root

# Install additional debugging tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    netcat-openbsd \
    jq \
    less \
    vim \
    && rm -rf /var/lib/apt/lists/*

# Create app directory for scripts
RUN mkdir -p /app/scripts /app/src && chown -R workspace:workspace /app

# Pre-create CLI config directories with correct ownership
# These will be overlaid by volumes but the ownership will persist
RUN mkdir -p /home/workspace/.claude \
             /home/workspace/.codex \
             /home/workspace/.gemini \
             /home/workspace/.cursor \
             /home/workspace/.config \
             /home/workspace/.local/share/opencode \
    && chown -R workspace:workspace /home/workspace/.claude \
                                    /home/workspace/.codex \
                                    /home/workspace/.gemini \
                                    /home/workspace/.cursor \
                                    /home/workspace/.config \
                                    /home/workspace/.local

# Copy scripts and source
COPY --chown=workspace:workspace scripts/ /app/scripts/
COPY --chown=workspace:workspace src/ /app/src/

# Make scripts executable
RUN chmod +x /app/scripts/*.sh

# Add scripts to PATH
ENV PATH="/app/scripts:${PATH}"

# Custom entrypoint that skips cloud-specific setup
COPY --chown=workspace:workspace docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Switch back to workspace user
USER workspace

# Set working directory
WORKDIR /home/workspace

# Use our simpler entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/bin/bash"]
