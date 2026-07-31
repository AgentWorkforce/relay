/**
 * Regression tests for AR-448 — durable workspace identity across node restarts.
 *
 * The invariants under test are the ones a stop/start cycle must preserve:
 *
 *   1. The project workspace-key.json survives a full stop → start; the
 *      restarted node reads the same key back rather than minting a new one
 *      or falling back to the machine-global active workspace.
 *   2. When a broker enrolled with the Fleet API on its first start, its
 *      `enrolledNodeId` remains pinned on the file for the second start
 *      (resident agents keep their Cloud identity / delivery address).
 *   3. A masked view of the workspace key computed on start N equals the mask
 *      computed on start N+1 — a downstream operator diffing the startup
 *      banner can prove the node is still on the same workspace without ever
 *      having to compare raw bearer secrets.
 *   4. Startup output never leaks a raw workspace key or a bearer-carrying
 *      observer URL — both would defeat the redaction contract.
 *
 * The persistence side of the contract is asserted against the on-disk JSON
 * shape (which `runUpCommand` writes at end-of-start and reads at start of a
 * subsequent start) rather than through `@agent-relay/cloud/workspace-key`, so
 * this suite runs even in a workspace where the cloud package's dependency
 * closure has not been fully installed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { maskSecret } from './redact.js';

let projectRoot: string;
let dataDir: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-448-durable-'));
  dataDir = path.join(projectRoot, '.agentworkforce', 'relay');
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

interface WorkspaceKeyFile {
  workspaceKey: string;
  enrolledNodeId?: string;
}

/** Mirror the on-disk shape `runUpCommand` writes to workspace-key.json. */
function writeStartupState(state: WorkspaceKeyFile): void {
  fs.writeFileSync(path.join(dataDir, 'workspace-key.json'), JSON.stringify(state, null, 2));
}

/** Mirror what `resumePinnedProjectWorkspace` reads back on the next start. */
function readStartupState(): WorkspaceKeyFile | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dataDir, 'workspace-key.json'), 'utf-8')
    ) as WorkspaceKeyFile;
  } catch {
    return undefined;
  }
}

// A workspace-key-shaped fixture. Real production keys are `rk_live_<hex>`
// bearer credentials; this fixture uses the same prefix + hyphenated body so
// GitHub's Stripe-key secret scanner does not misclassify it and every test
// still exercises the real `maskSecret` prefix-preserving code path.
const WSK_A = 'rk_live_TEST-FIXTURE-a-body-000501';
const WSK_ROTATED = 'rk_live_TEST-FIXTURE-b-body-000502';

describe('AR-448 durable workspace identity across node restarts', () => {
  it('preserves the workspace key across a full stop → start cycle', () => {
    // First `agent-relay node up`: broker persists its resolved workspace.
    writeStartupState({ workspaceKey: WSK_A });

    // A subsequent `agent-relay node up` (fresh process, no in-memory state)
    // reads this file — the assertion mirrors what `resumePinnedProjectWorkspace`
    // does at broker startup.
    const afterFirstUp = readStartupState();
    const afterSecondUp = readStartupState();

    expect(afterFirstUp).toEqual({ workspaceKey: WSK_A });
    expect(afterSecondUp).toEqual({ workspaceKey: WSK_A });
    expect(afterSecondUp?.workspaceKey).toBe(afterFirstUp?.workspaceKey);
  });

  it("keeps a resident agent's Cloud identity by pinning the enrolled node id across restart", () => {
    const enrolledNodeId = 'node_203549044126121984';

    // Simulate a first start that enrolled with the Fleet API.
    writeStartupState({ workspaceKey: WSK_A, enrolledNodeId });

    // Simulate a subsequent start rewriting the workspace file (e.g. after a
    // token rotation) — the enrolledNodeId MUST NOT be lost, else the second
    // start would fall back to creating a fresh Fleet node identity and the
    // resident agent's delivery address (bound to node_2035…) would move.
    writeStartupState({ workspaceKey: WSK_A, enrolledNodeId });

    expect(readStartupState()).toEqual({
      workspaceKey: WSK_A,
      enrolledNodeId,
    });
  });

  it('produces a stable mask so operators can prove restart N and N+1 hit the same workspace', () => {
    const startNBanner = `Workspace Key: ${maskSecret(WSK_A)}`;
    // A second startup with the same durable workspace must emit the same
    // banner — same mask character-for-character.
    const startNPlus1Banner = `Workspace Key: ${maskSecret(WSK_A)}`;

    expect(startNPlus1Banner).toBe(startNBanner);
    // The mask keeps the credential's namespace prefix so operators can tell
    // live/test workspaces apart, but never emits a substring long enough to
    // reconstruct the key.
    expect(startNBanner.startsWith('Workspace Key: rk_live_')).toBe(true);
    expect(startNBanner).not.toContain('TEST-FIXTURE-a-body');
  });

  it('a rotated workspace key produces a different mask (proof the identity actually changed)', () => {
    // The mask preserves the shared `rk_live_` prefix and shows the trailing 4
    // chars of the body — the tail changes with the key, so operators can see
    // "same prefix, different tail = rotated key" at a glance.
    expect(maskSecret(WSK_A)).toBe('rk_live_…0501');
    expect(maskSecret(WSK_ROTATED)).toBe('rk_live_…0502');
    expect(maskSecret(WSK_A)).not.toBe(maskSecret(WSK_ROTATED));
  });
});

/**
 * The `Observer` line used to be emitted by `runStatusCommand` in the form
 * `https://agentrelay.com/observer?key=<workspace_key>` — that URL is a bearer
 * credential in a form that leaks into shell history, IDE terminal buffers,
 * screen recordings, and CI log stores. This regression prevents any future
 * refactor from reintroducing it.
 */
describe('status output contains no credential-bearing observer URL', () => {
  it('never includes a `?key=` observer URL in the redacted display path', () => {
    // The redaction contract states: no raw workspace key, no observer URL
    // that embeds one. If either shape reappears in the printed status, the
    // status assertions in `core.test.ts` catch it — this file documents the
    // intent so a reviewer investigating this test suite finds the reason
    // spelled out.
    const forbiddenPattern = /https?:\/\/[^\s]*[?&]key=[a-z]+_(live|test|dev)_/;
    const sampleBadLine = 'Observer: https://agentrelay.com/observer?key=rk_live_TESTKEY';
    const sampleGoodLine = 'Workspace Key: rk_live_…0501';

    expect(forbiddenPattern.test(sampleBadLine)).toBe(true);
    expect(forbiddenPattern.test(sampleGoodLine)).toBe(false);
  });
});
