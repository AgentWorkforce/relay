# Post-publish verification Dockerfile
# Tests agent-relay npm package across Node.js versions
#
# Build args:
#   NODE_VERSION: Node.js version to test (18, 20, 22)
#   PACKAGE_VERSION: agent-relay version to test (default: latest)

ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-slim

ARG PACKAGE_VERSION=latest

# Install dependencies for native modules and better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create test user (don't run as root)
RUN useradd -m -s /bin/bash testuser

# Create npm global directory owned by testuser
RUN mkdir -p /home/testuser/.npm-global \
    && chown -R testuser:testuser /home/testuser

WORKDIR /home/testuser

# Store package version for verification script
ENV PACKAGE_VERSION=${PACKAGE_VERSION}
ENV NODE_VERSION=${NODE_VERSION}

# Configure npm to use user-owned global directory
ENV NPM_CONFIG_PREFIX=/home/testuser/.npm-global
ENV PATH=/home/testuser/.npm-global/bin:$PATH

# Copy verification script
COPY verify-install.sh /usr/local/bin/verify-install.sh
RUN chmod +x /usr/local/bin/verify-install.sh

# Switch to test user
USER testuser

# Run verification
CMD ["/usr/local/bin/verify-install.sh"]
