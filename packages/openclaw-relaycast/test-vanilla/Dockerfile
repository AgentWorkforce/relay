FROM alpine/openclaw:latest

USER root

# Install openclaw-relaycast and mcporter
COPY openclaw-relaycast-1.0.0.tgz /tmp/openclaw-relaycast-1.0.0.tgz
RUN npm install -g /tmp/openclaw-relaycast-1.0.0.tgz mcporter && rm /tmp/openclaw-relaycast-1.0.0.tgz

# Symlink openclaw binary to PATH so it's available globally
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw

# Verify installation
RUN openclaw --version && openclaw-relaycast --help

USER node
