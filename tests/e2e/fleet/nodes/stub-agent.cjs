#!/usr/bin/env node
'use strict';
// E2E stub "agent": the broker spawns this as a via-node PTY child after the
// token-authority handshake. It exposes the same readiness boundary as a real
// interactive harness and records an observable effect when a nonce-bearing
// brief reaches it. Before that boundary it deliberately discards input, which
// models a TUI consuming startup keystrokes before its prompt is ready.
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const readyDelayMs = Number.parseInt(process.env.RELAY_E2E_STUB_READY_DELAY_MS ?? '0', 10) || 0;
let ready = false;
let input = '';
const recordedNonces = new Set();

function recordBriefNonce(nonce) {
  if (recordedNonces.has(nonce)) return;
  recordedNonces.add(nonce);
  const projectDir = process.env.AGENT_RELAY_PROJECT;
  if (!projectDir) return;
  const observationDir = path.join(projectDir, '.agentworkforce', 'relay', 'e2e-brief-actions');
  mkdirSync(observationDir, { recursive: true });
  writeFileSync(
    path.join(observationDir, `${nonce}.json`),
    JSON.stringify({
      nonce,
      agent: process.env.RELAY_AGENT_NAME ?? null,
      node: process.env.RELAY_E2E_NODE_NAME ?? null,
      observedAt: new Date().toISOString(),
    })
  );
}

try {
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    if (!ready) return;
    input += chunk.toString();
    for (const match of input.matchAll(/RELAY_E2E_BRIEF_NONCE=([A-Za-z0-9_-]+)/g)) {
      recordBriefNonce(match[1]);
    }
    if (input.length > 32_000) input = input.slice(-16_000);
  });
} catch {
  /* no stdin */
}

setTimeout(() => {
  ready = true;
  process.stdout.write('->pty:ready\n');
}, readyDelayMs);

setInterval(() => {}, 1 << 30);
