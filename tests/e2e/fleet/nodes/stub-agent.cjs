#!/usr/bin/env node
'use strict';
// E2E stub "agent": the broker spawns this as a via-node PTY child after the
// token-authority handshake. It just drains stdin (the broker injects delivered
// messages there, so an undrained pipe could back-pressure delivery) and idles,
// keeping the agent registered via-node for the lifetime of the test. This is a
// proper, launchable PTY child without needing a real AI CLI.
try {
  process.stdin.resume();
  process.stdin.on('data', () => {});
} catch {
  /* no stdin */
}
setInterval(() => {}, 1 << 30);
