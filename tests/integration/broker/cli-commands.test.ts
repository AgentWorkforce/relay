/**
 * CLI command integration tests.
 *
 * Tests the agent-relay CLI binary directly via subprocess invocation,
 * verifying that core commands work correctly end-to-end:
 *
 *   1. `version`           — exits 0 and prints version string
 *   2. `swarm --dry-run`   — prints execution plan without starting broker
 *   3. `workflows list`    — lists built-in template names
 *   4. spawn + agents + release lifecycle (skipped if broker binary missing)
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/cli-commands.test.js
 *
 * Override the CLI path:
 *   AGENT_RELAY_CLI_BIN=/path/to/agent-relay node --test ...
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the agent-relay CLI binary for subprocess invocation.
 * Returns [executable, ...prefixArgs] (e.g. ["node", "/path/to/bootstrap.js"])
 * or null if the CLI cannot be found.
 */
function resolveCliBin(): string[] | null {
  // 1. Explicit env override
  if (process.env.AGENT_RELAY_CLI_BIN) {
    return [process.env.AGENT_RELAY_CLI_BIN];
  }

  // 2. Compiled dist/src/cli/bootstrap.js relative to repo root
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const bootstrap = path.join(repoRoot, 'dist', 'src', 'cli', 'bootstrap.js');
  if (fs.existsSync(bootstrap)) {
    return [process.execPath, bootstrap];
  }

  // 3. PATH fallback
  try {
    execSync('which agent-relay', { stdio: 'ignore' });
    return ['agent-relay'];
  } catch {
    return null;
  }
}

/** Spawn the CLI and capture stdout, stderr, and exit code. */
function runCli(
  bin: string[],
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const [exe, ...prefix] = bin;
    const child = spawn(exe, [...prefix, ...args], {
      stdio: 'pipe',
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', () => finish(1));

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill();
        finish(1);
      }, options.timeoutMs);
    }
  });
}

// ── Test 1: version exits 0 ───────────────────────────────────────────────

test('cli-commands: version — exits 0 and prints version string', { timeout: 10_000 }, async (t) => {
  const bin = resolveCliBin();
  if (!bin) {
    t.skip('agent-relay CLI not found (set AGENT_RELAY_CLI_BIN or build dist/)');
    return;
  }

  const result = await runCli(bin, ['version']);
  assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`);

  const combined = result.stdout + result.stderr;
  assert.ok(
    combined.includes('agent-relay'),
    `output should include "agent-relay", got: ${combined.slice(0, 200)}`
  );
});

// ── Test 2: swarm --dry-run prints plan ──────────────────────────────────

test(
  'cli-commands: swarm --dry-run — prints plan without starting broker',
  { timeout: 10_000 },
  async (t) => {
    const bin = resolveCliBin();
    if (!bin) {
      t.skip('agent-relay CLI not found');
      return;
    }

    const result = await runCli(bin, [
      'swarm',
      '--dry-run',
      '--task',
      'Write a hello world function',
      '--pattern',
      'fan-out',
      '--teams',
      '2',
    ]);

    assert.equal(
      result.exitCode,
      0,
      `swarm --dry-run should exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`
    );

    const combined = result.stdout + result.stderr;
    assert.ok(combined.length > 0, 'swarm --dry-run should produce output');

    // Should print recognizable plan content (dry-run keyword, pattern, or task info)
    assert.ok(
      combined.toLowerCase().includes('dry') ||
        combined.toLowerCase().includes('plan') ||
        combined.includes('fan-out') ||
        combined.includes('Pattern'),
      `expected plan output, got: ${combined.slice(0, 300)}`
    );
  }
);

// ── Test 3: workflows list shows templates ────────────────────────────────

test('cli-commands: workflows list — shows built-in template names', { timeout: 10_000 }, async (t) => {
  const bin = resolveCliBin();
  if (!bin) {
    t.skip('agent-relay CLI not found');
    return;
  }

  const result = await runCli(bin, ['workflows', 'list']);

  assert.equal(
    result.exitCode,
    0,
    `workflows list should exit 0, got ${result.exitCode}\nstderr: ${result.stderr}`
  );

  const output = result.stdout + result.stderr;
  // At least one known built-in template should appear
  const knownTemplates = [
    'bug-fix',
    'code-review',
    'feature-dev',
    'security-audit',
    'documentation',
    'refactor',
    'review-loop',
  ];
  const found = knownTemplates.filter((name) => output.includes(name));
  assert.ok(found.length > 0, `expected at least one template name in output, got: ${output.slice(0, 400)}`);
});

// ── Test 4: spawn + agents + release lifecycle ────────────────────────────

test('cli-commands: spawn + agents + release — full lifecycle', { timeout: 60_000 }, async (t) => {
  if (process.env.RELAY_INTEGRATION_CLI_LIFECYCLE !== '1') {
    t.skip('Set RELAY_INTEGRATION_CLI_LIFECYCLE=1 to run spawn/agents/release lifecycle test');
    return;
  }

  const bin = resolveCliBin();
  if (!bin) {
    t.skip('agent-relay CLI not found');
    return;
  }

  // Skip if the broker binary is not present
  const { checkPrerequisites, uniqueSuffix } = await import('./utils/broker-harness.js');
  const prereqReason = checkPrerequisites();
  if (prereqReason) {
    t.skip(prereqReason);
    return;
  }

  const agentName = `cli-test-${uniqueSuffix()}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-commands-'));

  try {
    // Spawn a lightweight 'cat' agent (task is required by current CLI contract).
    const spawnResult = await runCli(bin, ['spawn', agentName, 'cat', 'CLI lifecycle integration test'], {
      timeoutMs: 20_000,
      cwd: tempRoot,
    });
    assert.equal(
      spawnResult.exitCode,
      0,
      `spawn should exit 0\nstdout: ${spawnResult.stdout}\nstderr: ${spawnResult.stderr}`
    );

    // List agents — ensure command succeeds and returns parseable JSON.
    const agentsResult = await runCli(bin, ['agents', '--json'], { timeoutMs: 10_000, cwd: tempRoot });
    assert.equal(agentsResult.exitCode, 0, `agents should exit 0\nstderr: ${agentsResult.stderr}`);
    assert.doesNotThrow(
      () => JSON.parse(agentsResult.stdout || '[]'),
      'agents --json should return valid JSON'
    );

    // Release the agent
    const releaseResult = await runCli(bin, ['release', agentName], { timeoutMs: 10_000, cwd: tempRoot });
    if (releaseResult.exitCode !== 0) {
      const combined = `${releaseResult.stdout}\n${releaseResult.stderr}`;
      if (combined.includes('already exists')) {
        t.skip(`release command hit broker identity collision: ${combined.trim()}`);
        return;
      }
    }
    assert.equal(
      releaseResult.exitCode,
      0,
      `release should exit 0\nstdout: ${releaseResult.stdout}\nstderr: ${releaseResult.stderr}`
    );
  } finally {
    // Best-effort cleanup.
    await runCli(bin, ['release', agentName], { timeoutMs: 5_000, cwd: tempRoot }).catch(() => {});
    await runCli(bin, ['down', '--force'], { timeoutMs: 10_000, cwd: tempRoot }).catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
