import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIN_RELAYFILE_VERSION, assertRelayfileVersion, defaultRelayfileBridge } from './integration.js';
import { RelayfileControlPlaneClient } from '@relayfile/client';

// ────────────────────────────────────────────────────────────────────────────
// Pure version-gate unit tests — always run, no daemon required. These lock the
// daemon-version compat check (`/v1/hello` → daemonVersion) that turns "daemon
// too old" into a typed error instead of a mid-operation contract surprise.
// ────────────────────────────────────────────────────────────────────────────
describe('assertRelayfileVersion', () => {
  it('accepts the minimum version and anything newer', () => {
    expect(() => assertRelayfileVersion(MIN_RELAYFILE_VERSION)).not.toThrow();
    expect(() => assertRelayfileVersion('0.99.0')).not.toThrow();
    expect(() => assertRelayfileVersion('1.0.0')).not.toThrow();
  });

  it('tolerates a leading v and surrounding words', () => {
    expect(() => assertRelayfileVersion('v0.99.0')).not.toThrow();
    expect(() => assertRelayfileVersion('relayfile 0.99.0 (abc1234)')).not.toThrow();
  });

  it('rejects a version older than the minimum with an actionable message', () => {
    expect(() => assertRelayfileVersion('0.10.15')).toThrow(
      new RegExp(
        `relayfile >= ${MIN_RELAYFILE_VERSION.replace(/\./g, '\\.')} is required; found "0\\.10\\.15"`
      )
    );
  });

  it('rejects unparseable version output', () => {
    expect(() => assertRelayfileVersion('not a version')).toThrow(/unparseable version/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Real-daemon contract tests — boot `relayfile control-plane serve` and exercise
// the ACTUAL bridge over the unix socket (no spawn-per-op, no stdout parsing).
// This is the regression net for the socket contract: version handshake,
// native→glob resolve, and bind/list/unbind round-trip.
//
// Point RELAYFILE_BIN at the binary under test (CI: `go build -o relayfile
// ./cmd/relayfile-cli`). When unset these skip — opt-in, no PATH fallback.
// ────────────────────────────────────────────────────────────────────────────
const RELAYFILE_BIN = process.env.RELAYFILE_BIN?.trim();
const describeContract = RELAYFILE_BIN ? describe : describe.skip;

describeContract('relayfile bridge contract (real control-plane daemon)', () => {
  // Short socket path: macOS caps unix sun_path at ~104 bytes, so /tmp not the
  // (very long) test scratchpad.
  const sock = join(tmpdir(), `rf-contract-${process.pid}.sock`);
  let home: string;
  let daemon: ChildProcess;
  // autoStart:false — the daemon is already running, so the bridge never spawns.
  const bridge = defaultRelayfileBridge({ socketPath: sock, autoStart: false });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'relayfile-contract-'));
    daemon = spawn(RELAYFILE_BIN!, ['control-plane', 'serve', '--sock', sock], {
      env: { ...process.env, HOME: home, RELAYFILE_SOCK: sock },
      stdio: 'ignore',
    });
    // Wait for the socket to answer /v1/hello.
    const probe = new RelayfileControlPlaneClient({ socketPath: sock, autoStart: false });
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await probe.hello();
        return;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  afterAll(() => {
    daemon?.kill('SIGTERM');
    rmSync(sock, { force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('ensureCompatible() negotiates the daemon version over /v1/hello', async () => {
    await expect(bridge.ensureCompatible()).resolves.toBeUndefined();
  });

  it('resolveResourcePath() maps native -> glob and is idempotent', async () => {
    const fromNative = await bridge.resolveResourcePath('github', 'owner/repo');
    expect(fromNative.pathGlob).toBe('/github/repos/owner/repo/**');

    const fromGlob = await bridge.resolveResourcePath('github', '/github/repos/owner/repo/**');
    expect(fromGlob.pathGlob).toBe('/github/repos/owner/repo/**');
  });

  it('resolveResourcePath() surfaces a structured warning on wildcard fallback', async () => {
    const resolved = await bridge.resolveResourcePath('slack', '#general');
    expect(resolved.pathGlob.startsWith('/')).toBe(true);
    expect(resolved.warning).toBeTruthy();
  });

  it('bind -> listBindings -> unbind round-trips on the resolved glob', async () => {
    const { pathGlob } = await bridge.resolveResourcePath('github', 'acme/widgets');

    await bridge.bind({
      provider: 'github',
      resource: pathGlob,
      channel: 'general',
      webhookId: 'wh_contract',
      webhookToken: 'tok_contract',
      subscriptionId: 'sub_contract',
    });

    const afterBind = await bridge.listBindings();
    const binding = afterBind.find((b) => b.provider === 'github' && b.resource === pathGlob);
    expect(binding).toBeDefined();
    // Surfaced from relayfile's `pathGlob`, not the native spelling.
    expect(binding!.resource).toBe('/github/repos/acme/widgets/**');
    expect(binding!.channel).toBe('general');
    expect(binding!.webhookId).toBe('wh_contract');
    expect(binding!.subscriptionId).toBe('sub_contract');

    await bridge.unbind('github', pathGlob);
    const afterUnbind = await bridge.listBindings();
    expect(afterUnbind.find((b) => b.resource === pathGlob)).toBeUndefined();
  });
});
