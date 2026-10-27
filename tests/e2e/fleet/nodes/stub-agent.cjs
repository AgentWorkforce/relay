#!/usr/bin/env node
'use strict';
// E2E stub "agent": the broker spawns this as a via-node PTY child after the
// token-authority handshake. It exposes the same readiness boundary as a real
// interactive harness and records an observable effect when a nonce-bearing
// brief reaches it. Before that boundary it deliberately discards input, which
// models a TUI consuming startup keystrokes before its prompt is ready.
const { mkdirSync, writeFileSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const readyDelayMs = Number.parseInt(process.env.RELAY_E2E_STUB_READY_DELAY_MS ?? '0', 10) || 0;
let ready = false;
let input = '';
let deliveryInput = '';
const recordedNonces = new Set();
const nonceMarker = 'RELAY_E2E_BRIEF_NONCE=';
const maxNonceLength = 256;
const noncePattern = new RegExp(`${nonceMarker}([A-Za-z0-9_-]{1,${maxNonceLength}})(?=[^A-Za-z0-9_-])`, 'g');

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
      args: process.argv.slice(2),
      observedAt: new Date().toISOString(),
    })
  );
}

// Invoked as `codex`, model Codex's composer closely enough for the broker's
// chunked initial-task path: raw input (no kernel echo, so discarded
// pre-ready keystrokes never appear), typed text rendered after the `›`
// prompt, and Enter submitting the turn and redrawing an empty composer.
// These screen changes guide chunking only; the native receipt confirms delivery.
const codexComposer = path.basename(process.argv[1]) === 'codex';
if (process.stdin.isTTY) process.stdin.setRawMode(true);

function renderCodexComposer(text) {
  for (const ch of text) {
    if (ch === '\r') process.stdout.write('\r\n› ');
    else if (ch === '\n') process.stdout.write('\r\n  ');
    else process.stdout.write(ch);
  }
}

try {
  // Decode as a stream: a UTF-8 character can straddle two PTY reads.
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (chunk) => {
    if (!ready) return;
    if (codexComposer) renderCodexComposer(chunk.toString());
    // Acknowledge a submitted delivery from the recipient, independent of the screen.
    deliveryInput = (deliveryInput + chunk.toString()).slice(-65536);
    const ackDir = process.env.RELAY_PTY_ACK_DIR;
    if (ackDir && chunk.toString().includes('\r')) {
      for (const name of readdirSync(ackDir).filter((name) => name.endsWith('.pending'))) {
        const receipt = JSON.parse(readFileSync(path.join(ackDir, name), 'utf8'));
        if (deliveryInput.includes(receipt.messageId)) {
          writeFileSync(path.join(ackDir, `${name.slice(0, -8)}.${receipt.nonce}.read`), receipt.nonce);
        }
      }
      deliveryInput = '';
    }
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
  // Model Codex's actual composer glyph and cursor, rather than Claude's ❯.
  // The broker verifies the settled composer without requiring a transient
  // MCP boot label. This native stub starts no MCP/AI service.
  if (path.basename(process.argv[1]) === 'codex') {
    process.stdout.write('› ');
  } else {
    process.stdout.write('❯ ');
  }
}, readyDelayMs);

setInterval(() => {}, 1 << 30);
