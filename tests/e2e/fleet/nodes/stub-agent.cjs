#!/usr/bin/env node
'use strict';
// E2E stub "agent": the broker spawns this as a via-node PTY child after the
// token-authority handshake. It exposes the same readiness boundary as a real
// interactive harness and records an observable effect when a nonce-bearing
// brief reaches it. Before that boundary it deliberately discards input, which
// models a TUI consuming startup keystrokes before its prompt is ready.
const { mkdirSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { RELEASE_PROBE_PID_FILE } = require('./release-probe-constants.cjs');

const readyDelayMs = Number.parseInt(process.env.RELAY_E2E_STUB_READY_DELAY_MS ?? '0', 10) || 0;
let ready = false;
let input = '';
const recordedNonces = new Set();
const nonceMarker = 'RELAY_E2E_BRIEF_NONCE=';
const maxNonceLength = 256;
const noncePattern = new RegExp(`${nonceMarker}([A-Za-z0-9_-]{1,${maxNonceLength}})(?=[^A-Za-z0-9_-])`, 'g');

// The release regression harness deliberately creates a grandchild that the
// wrapper does not clean up on SIGTERM. Base brokers signal only this process;
// fixed brokers signal the private worker process group. The PID is written
// under the node's isolated project directory so the test can prove absence
// without relying on a process-name scan.
let releaseProbeChild;
if (process.env.RELAY_E2E_SPAWN_DESCENDANT === '1') {
  const projectDir = process.env.AGENT_RELAY_PROJECT;
  if (!projectDir) throw new Error('release probe requires AGENT_RELAY_PROJECT');
  const pidPath = path.join(projectDir, '.agentworkforce', 'relay', RELEASE_PROBE_PID_FILE);
  mkdirSync(path.dirname(pidPath), { recursive: true });
  releaseProbeChild = spawn('sleep', ['300'], { stdio: 'ignore' });
  releaseProbeChild.once('error', (error) => {
    process.stderr.write(`release probe descendant failed to spawn: ${error.message}\n`);
    process.exit(1);
  });
  // Child.pid is not guaranteed until the spawn event. Writing only after that
  // event removes the PID-file race used by the release absence assertion.
  releaseProbeChild.once('spawn', () => writeFileSync(pidPath, `${releaseProbeChild.pid}\n`));
}

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
    // Require a delimiter after the nonce. PTY chunks can split anywhere, so
    // treating the current buffer end as a complete token could record a
    // truncated nonce before its remaining characters arrive.
    let consumedThrough = 0;
    for (const match of input.matchAll(noncePattern)) {
      recordBriefNonce(match[1]);
      consumedThrough = match.index + match[0].length + 1;
    }
    if (consumedThrough > 0) input = input.slice(consumedThrough);

    // Keep only a possible partial marker/candidate between chunks. This
    // bounds memory and avoids rescanning already-consumed PTY input while
    // preserving a nonce whose marker or delimiter straddles a chunk boundary.
    const maxCandidateLength = nonceMarker.length + maxNonceLength;
    if (input.length > maxCandidateLength) {
      const candidateStart = input.lastIndexOf(nonceMarker);
      input =
        candidateStart >= 0 && input.length - candidateStart <= maxCandidateLength
          ? input.slice(candidateStart)
          : input.slice(-(nonceMarker.length - 1));
    }
  });
} catch {
  /* no stdin */
}

setTimeout(() => {
  ready = true;
  process.stdout.write('->pty:ready\n');
}, readyDelayMs);

setInterval(() => {}, 1 << 30);
