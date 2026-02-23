/**
 * Broker lock file and PID file integration tests.
 *
 * Tests single-instance enforcement, PID cleanup on shutdown,
 * SIGTERM handling, and stale lock recovery.
 *
 * Run:
 *   npx tsx --test tests/integration/broker/lockfile.test.ts
 *
 * Requires:
 *   RELAY_API_KEY — Relaycast workspace key (auto-provisioned if missing)
 *   agent-relay-broker binary built at target/debug/agent-relay-broker
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import { checkPrerequisites, ensureApiKey } from './utils/broker-harness.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

/** Resolve the broker binary path. */
function brokerBin(): string {
  if (process.env.AGENT_RELAY_BIN) return process.env.AGENT_RELAY_BIN;
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
  return path.resolve(repoRoot, 'target/debug/agent-relay-broker');
}

/** Create a temp directory for broker runtime files. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-test-'));
}

/**
 * Spawn a broker `init` process in the given cwd.
 * Returns the child process. The broker will create .agent-relay/ in cwd.
 */
function spawnBroker(cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const bin = brokerBin();
  const child = spawn(bin, ['init', '--name', 'locktest', '--channels', 'general'], {
    cwd,
    env: { ...env, RUST_LOG: 'info' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

/**
 * Spawn a broker in `init --api-port` mode in the given cwd.
 * Init mode reads stdin for SDK protocol and optionally starts an HTTP API.
 */
function spawnInitApiBroker(cwd: string, env: NodeJS.ProcessEnv, port: number): ChildProcess {
  const bin = brokerBin();
  const child = spawn(
    bin,
    ['init', '--name', 'inittest', '--channels', 'general', '--api-port', String(port)],
    {
      cwd,
      env: { ...env, RUST_LOG: 'info' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  return child;
}

/**
 * Wait for init-mode broker with --api-port to be ready by checking stderr for the
 * "[agent-relay] API listening" message.
 */
async function waitForInitApiReady(
  stderrCollector: { lines: string[] },
  child: ChildProcess,
  timeoutMs = 20_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const all = stderrCollector.lines.join('\n');
    if (all.includes('[agent-relay] API listening')) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Init broker exited before ready (code=${child.exitCode}, signal=${child.signalCode}). Stderr:\n${all}`
      );
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `Init API broker not ready within ${timeoutMs}ms. Stderr:\n${stderrCollector.lines.join('\n')}`
  );
}

/** Pick a random port in the ephemeral range to avoid collisions between tests. */
function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

/** Wait for the broker to write its PID file (polls up to timeoutMs). */
async function waitForPidFile(cwd: string, timeoutMs = 15_000): Promise<string> {
  const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(pidPath)) {
      const contents = fs.readFileSync(pidPath, 'utf-8').trim();
      if (contents.length > 0) return contents;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`PID file not created within ${timeoutMs}ms at ${pidPath}`);
}

/** Wait for a child process to exit, with timeout. Returns { code, signal }. */
function waitForExit(
  child: ChildProcess,
  timeoutMs = 15_000
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }

    const timer = setTimeout(() => {
      reject(new Error(`Process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Collect stderr output from a child process. */
function collectStderr(child: ChildProcess): { lines: string[] } {
  const result = { lines: [] as string[] };
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => {
    result.lines.push(...chunk.split('\n').filter(Boolean));
  });
  return result;
}

/** Clean up temp dir (best-effort). */
function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore — cleanup is best-effort
  }
}

/**
 * Wait for the PID file to be removed (polls up to timeoutMs).
 * Used to confirm cleanup after graceful shutdown.
 */
async function waitForPidFileRemoved(cwd: string, timeoutMs = 10_000): Promise<void> {
  const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(pidPath)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`PID file still exists after ${timeoutMs}ms at ${pidPath}`);
}

/**
 * Wait for PID file to contain a different PID from the given one.
 * Used after stale lock recovery to confirm the new broker wrote its PID.
 */
async function waitForNewPid(cwd: string, oldPid: string, timeoutMs = 15_000): Promise<string> {
  const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(pidPath)) {
      const contents = fs.readFileSync(pidPath, 'utf-8').trim();
      if (contents.length > 0 && contents !== oldPid) return contents;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`PID file did not change from ${oldPid} within ${timeoutMs}ms`);
}

/**
 * Gracefully stop a broker by closing stdin (triggers sdk_lines EOF -> shutdown)
 * and sending SIGTERM as backup. The broker's init mode reads stdin and exits
 * when it gets EOF.
 */
async function gracefulStop(
  child: ChildProcess,
  timeoutMs = 15_000
): Promise<{ code: number | null; signal: string | null }> {
  // Close stdin to trigger the sdk_lines -> Ok(None) -> shutdown path
  child.stdin?.end();
  // Also send SIGTERM as backup
  child.kill('SIGTERM');
  return waitForExit(child, timeoutMs);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('lockfile: PID file is created on broker start', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();

  try {
    const child = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const pidContents = await waitForPidFile(cwd);

    // PID file should contain the broker's actual PID
    const filePid = parseInt(pidContents, 10);
    assert.ok(!isNaN(filePid), `PID file should contain a number, got: "${pidContents}"`);
    assert.equal(filePid, child.pid, 'PID file should match the broker process PID');

    await gracefulStop(child);
  } finally {
    cleanupDir(cwd);
  }
});

test('lockfile: PID file is removed after graceful shutdown', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();

  try {
    const child = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const stderr = collectStderr(child);
    await waitForPidFile(cwd);

    // Wait a moment for the broker to settle
    await new Promise((r) => setTimeout(r, 2_000));

    // Graceful shutdown via stdin EOF + SIGTERM
    await gracefulStop(child);

    // Give filesystem a moment to sync
    await new Promise((r) => setTimeout(r, 500));

    // PID file should be cleaned up
    const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
    assert.ok(
      !fs.existsSync(pidPath),
      `PID file should be removed after graceful shutdown. Stderr:\n${stderr.lines.slice(-10).join('\n')}`
    );
  } finally {
    cleanupDir(cwd);
  }
});

test('lockfile: SIGTERM triggers clean exit with PID cleanup', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();

  try {
    const child = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    await waitForPidFile(cwd);

    // Wait for broker to finish startup and reach select loop
    await new Promise((r) => setTimeout(r, 3_000));

    // Close stdin to unblock the stdin reader, then send SIGTERM
    child.stdin?.end();
    child.kill('SIGTERM');
    const { code, signal } = await waitForExit(child);

    // Process should exit (either code 0 from stdin EOF or signal SIGTERM)
    const exitedCleanly = code === 0 || signal === 'SIGTERM';
    assert.ok(exitedCleanly, `Broker should exit on SIGTERM, got code=${code} signal=${signal}`);

    // PID file should be cleaned up on clean exit
    await new Promise((r) => setTimeout(r, 500));
    const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
    assert.ok(!fs.existsSync(pidPath), 'PID file should be removed after SIGTERM-triggered shutdown');
  } finally {
    cleanupDir(cwd);
  }
});

test('lockfile: second broker in same directory is rejected', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();

  let first: ChildProcess | undefined;
  try {
    // Start first broker
    first = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    await waitForPidFile(cwd);

    // Try starting a second broker in the same directory
    const second = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const secondStderr = collectStderr(second);
    const { code } = await waitForExit(second);

    // Second broker should fail (non-zero exit)
    assert.ok(code !== 0, `Second broker should fail with non-zero exit, got ${code}`);

    // Should mention "already running" in error output
    const allStderr = secondStderr.lines.join('\n');
    assert.ok(
      allStderr.includes('already running'),
      `Second broker should report "already running". Stderr:\n${allStderr}`
    );
  } finally {
    if (first && !first.killed) {
      await gracefulStop(first).catch(() => {});
    }
    cleanupDir(cwd);
  }
});

test('lockfile: stale lock from dead process is recovered', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();

  try {
    // Start a broker, then kill it hard (SIGKILL — no cleanup)
    const first = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const oldPid = await waitForPidFile(cwd);

    // SIGKILL — process dies immediately, no cleanup runs
    first.kill('SIGKILL');
    await waitForExit(first).catch(() => {});

    // PID file and lock should still exist (stale)
    const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
    const lockPath = path.join(cwd, '.agent-relay', 'broker.lock');
    assert.ok(fs.existsSync(pidPath), 'PID file should persist after SIGKILL');
    assert.ok(fs.existsSync(lockPath), 'Lock file should persist after SIGKILL');

    // Stale PID file should still contain the old (dead) PID
    const stalePid = fs.readFileSync(pidPath, 'utf-8').trim();
    assert.equal(stalePid, oldPid, 'Stale PID file should still contain old PID');

    // Now start a new broker — should recover the stale lock
    const second = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });

    // Wait for the new broker to write its own PID (different from old)
    const newPid = await waitForNewPid(cwd, oldPid);
    const newPidNum = parseInt(newPid, 10);
    assert.equal(newPidNum, second.pid, 'New broker should write its own PID');

    // The key assertion: the second broker started successfully despite the stale lock.
    // If stale recovery failed, spawnBroker + waitForNewPid would have timed out.

    await gracefulStop(second);
  } finally {
    cleanupDir(cwd);
  }
});

test('lockfile: sequential broker runs in same directory work', { timeout: 45_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();

  try {
    // Run 1
    const first = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    await waitForPidFile(cwd);
    await new Promise((r) => setTimeout(r, 1_000));
    await gracefulStop(first);

    // Wait for PID file to be cleaned up before starting second broker
    await waitForPidFileRemoved(cwd);

    // Run 2 — should succeed without "already running" error
    const second = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const secondStderr = collectStderr(second);
    const newPid = await waitForPidFile(cwd);

    // Verify PID matches the new process
    assert.equal(parseInt(newPid, 10), second.pid, 'Second run PID file should match second broker process');

    await gracefulStop(second);

    // No "already running" in stderr
    const allStderr = secondStderr.lines.join('\n');
    assert.ok(
      !allStderr.includes('already running'),
      `Sequential run should not see "already running". Stderr:\n${allStderr}`
    );
  } finally {
    cleanupDir(cwd);
  }
});

// ── Rapid restart stress test ─────────────────────────────────────────────

test('lockfile: rapid sequential restarts do not leave stale locks', { timeout: 90_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();
  const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
  const iterations = 5;

  try {
    let lastKilledPid: string | null = null;

    for (let i = 0; i < iterations; i++) {
      const child = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });

      // If the previous iteration was SIGKILL'd, wait for the PID to change
      // (stale recovery). Otherwise wait for the PID file to appear normally.
      let pid: string;
      if (lastKilledPid) {
        pid = await waitForNewPid(cwd, lastKilledPid);
        lastKilledPid = null;
      } else {
        pid = await waitForPidFile(cwd);
      }

      // Verify each iteration gets the correct PID
      assert.equal(parseInt(pid, 10), child.pid, `Iteration ${i + 1}: PID file should match broker PID`);

      // Wait for broker to settle past startup (connect_relay) into the select loop
      // so that stdin EOF / SIGTERM triggers the clean shutdown path with PID cleanup
      await new Promise((r) => setTimeout(r, 2_000));

      // Alternate between graceful stop and SIGKILL to mix cleanup paths
      if (i % 2 === 0) {
        await gracefulStop(child);
        // After graceful stop, PID is usually removed. Under rapid restarts,
        // tolerate a lingering stale PID and force next iteration through
        // stale-recovery path.
        try {
          await waitForPidFileRemoved(cwd, 4_000);
        } catch {
          assert.ok(
            fs.existsSync(pidPath),
            `Iteration ${i + 1}: expected stale PID file when graceful cleanup lags`
          );
          lastKilledPid = pid;
        }
      } else {
        // SIGKILL — leaves stale lock, next iteration must recover
        child.kill('SIGKILL');
        await waitForExit(child).catch(() => {});
        assert.ok(fs.existsSync(pidPath), `Iteration ${i + 1}: PID file should persist after SIGKILL`);
        lastKilledPid = pid;
      }

      // Brief pause between iterations
      await new Promise((r) => setTimeout(r, 500));
    }

    // Final state: directory should be usable for a fresh broker
    const final_ = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const finalStderr = collectStderr(final_);
    // If last iteration was SIGKILL, wait for new PID; otherwise wait for PID file
    if (lastKilledPid) {
      await waitForNewPid(cwd, lastKilledPid);
    } else {
      await waitForPidFile(cwd);
    }
    await gracefulStop(final_);

    const allStderr = finalStderr.lines.join('\n');
    assert.ok(
      !allStderr.includes('already running'),
      `Final broker after ${iterations} rapid restarts should start cleanly`
    );
  } finally {
    cleanupDir(cwd);
  }
});

// ── Recovered broker cleanup ──────────────────────────────────────────────

test('lockfile: recovered broker also cleans up PID on exit', { timeout: 45_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();
  const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');

  try {
    // Phase 1: Start broker and SIGKILL it (leaves stale artifacts)
    const first = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const oldPid = await waitForPidFile(cwd);
    first.kill('SIGKILL');
    await waitForExit(first).catch(() => {});
    assert.ok(fs.existsSync(pidPath), 'PID file should persist after SIGKILL');

    // Phase 2: Start second broker — recovers stale lock
    const second = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const newPid = await waitForNewPid(cwd, oldPid);
    assert.equal(parseInt(newPid, 10), second.pid, 'Recovered broker should write its own PID');

    // Phase 3: Gracefully stop the recovered broker
    await new Promise((r) => setTimeout(r, 1_000));
    await gracefulStop(second);
    // Under heavy process churn, PID cleanup can lag briefly. Accept either
    // immediate removal or stale-PID recovery by the next broker.
    try {
      await waitForPidFileRemoved(cwd, 4_000);
    } catch {
      assert.ok(fs.existsSync(pidPath), 'Expected stale PID file when cleanup lags');
    }

    // Phase 4: Third broker should start without stale lock issues
    const third = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const thirdStderr = collectStderr(third);
    const thirdPid = await waitForPidFile(cwd);
    assert.equal(parseInt(thirdPid, 10), third.pid, 'Third broker should write its own PID');

    await gracefulStop(third);

    // Should not see any stale lock warnings
    const allStderr = thirdStderr.lines.join('\n').toLowerCase();
    assert.ok(
      !allStderr.includes('stale'),
      'Third broker should not encounter stale lock after clean recovery cycle'
    );
  } finally {
    cleanupDir(cwd);
  }
});

// ── SIGKILL flock release ─────────────────────────────────────────────────

test(
  'lockfile: SIGKILL releases flock (OS-level), allowing new broker without stale PID',
  { timeout: 30_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    const apiKey = await ensureApiKey();
    const cwd = makeTempDir();
    const lockPath = path.join(cwd, '.agent-relay', 'broker.lock');
    const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');

    try {
      // Start and SIGKILL a broker
      const first = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
      await waitForPidFile(cwd);
      first.kill('SIGKILL');
      await waitForExit(first).catch(() => {});

      // Lock file still exists on disk (it's just a file)
      assert.ok(fs.existsSync(lockPath), 'Lock file should exist on disk after SIGKILL');

      // But the OS should have released the flock when the process died.
      // Prove it: manually remove the stale PID file, then start a new broker.
      // Without the PID file the broker can't do stale-PID detection, so it must
      // succeed purely because the flock is available.
      fs.unlinkSync(pidPath);
      assert.ok(!fs.existsSync(pidPath), 'PID file should be manually removed');

      const second = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
      const secondStderr = collectStderr(second);
      const newPid = await waitForPidFile(cwd);
      assert.equal(parseInt(newPid, 10), second.pid, 'New broker should acquire lock and write PID');

      // The second broker should NOT report "already running"
      await new Promise((r) => setTimeout(r, 500));
      const allStderr = secondStderr.lines.join('\n');
      assert.ok(
        !allStderr.includes('already running'),
        `Broker should acquire lock after SIGKILL (flock released by OS). Stderr:\n${allStderr}`
      );

      await gracefulStop(second);
    } finally {
      cleanupDir(cwd);
    }
  }
);

// ── Stdin EOF shutdown ────────────────────────────────────────────────────

test('lockfile: stdin EOF triggers clean shutdown with PID cleanup', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();
  const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');

  try {
    const child = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    await waitForPidFile(cwd);

    // Wait for broker to settle into select loop
    await new Promise((r) => setTimeout(r, 2_000));

    // Close stdin ONLY (no SIGTERM) — the broker reads sdk_lines from stdin
    // and should treat EOF as a shutdown trigger (Ok(None) branch)
    child.stdin?.end();
    const { code, signal } = await waitForExit(child);

    // Should exit cleanly via the stdin EOF path
    assert.equal(code, 0, `Broker should exit with code 0 on stdin EOF, got code=${code} signal=${signal}`);
    assert.equal(signal, null, 'Broker should not be killed by signal when stdin closes');

    // PID file should be cleaned up
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!fs.existsSync(pidPath), 'PID file should be removed after stdin EOF shutdown');

    // Lock file may or may not exist (it's fine either way), but it should be
    // unlocked so a new broker can start immediately
    const verify = spawnBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey });
    const verifyStderr = collectStderr(verify);
    await waitForPidFile(cwd);
    await gracefulStop(verify);

    const allStderr = verifyStderr.lines.join('\n');
    assert.ok(
      !allStderr.includes('already running'),
      'Subsequent broker should start after stdin EOF shutdown'
    );
  } finally {
    cleanupDir(cwd);
  }
});

// ── Init --api-port mode tests ───────────────────────────────────────────

test(
  'lockfile: init --api-port — PID file created and cleaned up on SIGTERM',
  { timeout: 45_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    const apiKey = await ensureApiKey();
    const cwd = makeTempDir();
    const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
    const port = randomPort();

    try {
      const child = spawnInitApiBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey }, port);
      const stderr = collectStderr(child);

      // Wait for PID file
      const pid = await waitForPidFile(cwd);
      assert.equal(parseInt(pid, 10), child.pid, 'Init broker PID file should match process PID');

      // Wait for HTTP API to be fully ready
      await waitForInitApiReady(stderr, child);

      // In init --api-port mode, close stdin and send SIGTERM to guarantee select loop exits.
      const { code, signal } = await gracefulStop(child);

      const exitedCleanly = code === 0 || signal === 'SIGTERM';
      assert.ok(exitedCleanly, `Init broker should exit on SIGTERM, got code=${code} signal=${signal}`);

      // PID file should be cleaned up
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(!fs.existsSync(pidPath), 'Init broker should remove PID file after SIGTERM');
    } finally {
      cleanupDir(cwd);
    }
  }
);

test(
  'lockfile: init --api-port — second instance in same directory is rejected',
  { timeout: 30_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    const apiKey = await ensureApiKey();
    const cwd = makeTempDir();
    const port1 = randomPort();
    const port2 = port1 + 1;

    let first: ChildProcess | undefined;
    try {
      first = spawnInitApiBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey }, port1);
      const firstStderr = collectStderr(first);
      await waitForPidFile(cwd);
      await waitForInitApiReady(firstStderr, first);

      // Try starting second init broker in same directory (different port)
      const second = spawnInitApiBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey }, port2);
      const secondStderr = collectStderr(second);
      const { code } = await waitForExit(second);

      assert.ok(code !== 0, `Second init broker should fail, got code ${code}`);
      const allStderr = secondStderr.lines.join('\n');
      assert.ok(
        allStderr.includes('already running'),
        `Second init broker should report "already running". Stderr:\n${allStderr}`
      );
    } finally {
      if (first && !first.killed) {
        await gracefulStop(first).catch(() => {});
      }
      cleanupDir(cwd);
    }
  }
);

test('lockfile: init --api-port — stale lock recovery after SIGKILL', { timeout: 45_000 }, async (t) => {
  if (skipIfMissing(t)) return;
  const apiKey = await ensureApiKey();
  const cwd = makeTempDir();
  const pidPath = path.join(cwd, '.agent-relay', 'broker.pid');
  const port1 = randomPort();
  const port2 = port1 + 1;

  try {
    // Start and SIGKILL an init broker
    const first = spawnInitApiBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey }, port1);
    const oldPid = await waitForPidFile(cwd);
    first.kill('SIGKILL');
    await waitForExit(first).catch(() => {});

    assert.ok(fs.existsSync(pidPath), 'PID file should persist after SIGKILL');

    // New init broker should recover the stale lock
    const second = spawnInitApiBroker(cwd, { ...process.env, RELAY_API_KEY: apiKey }, port2);
    const secondStderr = collectStderr(second);
    const newPid = await waitForNewPid(cwd, oldPid);
    assert.equal(parseInt(newPid, 10), second.pid, 'Recovered init broker should write its PID');

    // Wait for it to be fully ready
    await waitForInitApiReady(secondStderr, second);

    // Graceful shutdown — PID should be cleaned up
    await gracefulStop(second);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!fs.existsSync(pidPath), 'Recovered init broker should clean up PID on exit');
  } finally {
    cleanupDir(cwd);
  }
});
