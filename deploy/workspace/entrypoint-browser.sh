#!/usr/bin/env bash

set -euo pipefail

log() {
  echo "[workspace-browser] $*"
}

# ============================================================================
# Start Virtual Display (Xvfb)
# ============================================================================
log "Starting Xvfb virtual display..."
Xvfb :99 -screen 0 "${SCREEN_WIDTH:-1920}x${SCREEN_HEIGHT:-1080}x${SCREEN_DEPTH:-24}" &
XVFB_PID=$!
sleep 1

# Verify Xvfb started
if ! kill -0 $XVFB_PID 2>/dev/null; then
  log "ERROR: Xvfb failed to start"
  exit 1
fi
log "Xvfb started on display :99"

# ============================================================================
# Start Window Manager (Fluxbox)
# ============================================================================
log "Starting Fluxbox window manager..."
fluxbox &
sleep 1
log "Fluxbox started"

# ============================================================================
# Start VNC Server (optional, for debugging/viewing)
# ============================================================================
if [[ "${VNC_ENABLED:-true}" == "true" ]]; then
  log "Starting x11vnc server..."
  x11vnc -display :99 -forever -shared -rfbport "${VNC_PORT:-5900}" -bg -nopw -xkb
  log "VNC server started on port ${VNC_PORT:-5900}"

  # Start noVNC for browser-based access
  if [[ "${NOVNC_ENABLED:-true}" == "true" ]]; then
    log "Starting noVNC web interface..."
    websockify --web=/usr/share/novnc/ "${NOVNC_PORT:-6080}" localhost:"${VNC_PORT:-5900}" &
    log "noVNC available at http://localhost:${NOVNC_PORT:-6080}/vnc.html"
  fi
fi

# ============================================================================
# Export browser testing utilities
# ============================================================================

# Create screenshot helper
cat > /usr/local/bin/take-screenshot <<'EOF'
#!/usr/bin/env bash
# Take a screenshot and save to specified path
# Usage: take-screenshot [output.png]
OUTPUT="${1:-/tmp/screenshot-$(date +%Y%m%d-%H%M%S).png}"
DISPLAY=:99 scrot "$OUTPUT"
echo "$OUTPUT"
EOF
chmod +x /usr/local/bin/take-screenshot

# Create browser launcher helper
cat > /usr/local/bin/launch-browser <<'EOF'
#!/usr/bin/env bash
# Launch browser with optional URL
# Usage: launch-browser [url]
URL="${1:-about:blank}"
DISPLAY=:99 chromium --no-sandbox --disable-gpu --start-maximized "$URL" &
echo "Browser launched with PID $!"
EOF
chmod +x /usr/local/bin/launch-browser

# Create Playwright test runner helper
cat > /usr/local/bin/run-playwright <<'EOF'
#!/usr/bin/env bash
# Run Playwright tests with proper display settings
# Usage: run-playwright [test-file.spec.ts] [additional args...]
export DISPLAY=:99
npx playwright test "$@"
EOF
chmod +x /usr/local/bin/run-playwright

# ============================================================================
# Docker-in-Docker helper (if socket mounted)
# ============================================================================
if [[ -S /var/run/docker.sock ]]; then
  log "Docker socket detected - agents can spawn containers"

  # Create helper for agents to spawn isolated containers
  cat > /usr/local/bin/spawn-container <<'EOF'
#!/usr/bin/env bash
# Spawn an isolated container for agent tasks
# Usage: spawn-container <image> [command...]
IMAGE="${1:-ubuntu:22.04}"
shift
docker run --rm -it \
  --network=host \
  -v "$(pwd):/workspace" \
  -w /workspace \
  "$IMAGE" "$@"
EOF
  chmod +x /usr/local/bin/spawn-container
else
  log "WARN: Docker socket not mounted - container spawning disabled"
fi

# ============================================================================
# Continue with main entrypoint
# ============================================================================
log "Browser testing environment ready"
log "  - Display: $DISPLAY (${SCREEN_WIDTH}x${SCREEN_HEIGHT})"
log "  - VNC: ${VNC_ENABLED:-true} (port ${VNC_PORT:-5900})"
log "  - noVNC: ${NOVNC_ENABLED:-true} (http://localhost:${NOVNC_PORT:-6080})"
log "  - Playwright: $(npx playwright --version 2>/dev/null || echo 'installed')"

# Hand off to main entrypoint
exec /entrypoint.sh "$@"
