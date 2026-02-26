/**
 * Integration tests for non-interactive agent subprocess behavior.
 *
 * These tests use the *real* `claude -p` CLI to exercise the actual subprocess
 * spawning code path, including .mcp.json loading. Fakes/stubs are deliberately
 * avoided so we catch real hangs and real env-propagation failures.
 *
 * Bugs targeted:
 *   1. RELAY_API_KEY (and relay.env vars) not propagated to non-interactive
 *      subprocesses — execNonInteractive used { ...process.env } instead of
 *      getRelayEnv(), so the MCP server started unauthenticated and could hang.
 *   2. Swarm-level timeoutMs was not the fallback for non-interactive steps,
 *      meaning steps without an explicit timeoutMs ran with no deadline.
 *
 * Run from a terminal (not inside Claude Code):
 *   node --test tests/integration/broker/dist/workflow-noninteractive.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

import type { RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { WorkflowRunner } from '@agent-relay/sdk/workflows';
import { checkPrerequisites, ensureApiKey, resolveBinaryPath } from './utils/broker-harness.js';

// ── Guards ───────────────────────────────────────────────────────────────────

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

function skipIfNestedClaude(t: TestContext): boolean {
  if (process.env.CLAUDECODE) {
    t.skip('Cannot run nested claude sessions — run from a terminal, not inside Claude Code');
    return true;
  }
  return false;
}

function skipIfNoClaude(t: TestContext): boolean {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return false;
  } catch {
    t.skip('claude CLI not found in PATH');
    return true;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-ni-'));
}

/** Copy the project .mcp.json into workdir so claude loads the MCP server. */
function injectMcpJson(workdir: string): void {
  const src = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../.mcp.json');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(workdir, '.mcp.json'));
  }
}

function makeNonInteractiveConfig(
  overrides: Partial<RelayYamlConfig> & {
    task: string;
    timeoutMs?: number;
    verification?: { type: 'output_contains'; value: string };
    swarmTimeoutMs?: number;
    stepTimeoutMs?: number;
  }
): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-ni',
    description: 'Non-interactive subprocess integration test',
    swarm: {
      pattern: 'pipeline',
      timeoutMs: overrides.swarmTimeoutMs,
    },
    agents: [
      {
        name: 'analyst',
        cli: 'claude',
        interactive: false,
        constraints: { model: 'haiku' },
      },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'check',
            agent: 'analyst',
            task: overrides.task,
            timeoutMs: overrides.stepTimeoutMs,
            ...(overrides.verification ? { verification: overrides.verification } : {}),
          },
        ],
      },
    ],
  };
}

async function runWorkflow(
  config: RelayYamlConfig,
  workdir: string,
  relayEnv?: NodeJS.ProcessEnv
): Promise<{ status: string; error?: string; stepError?: string }> {
  const apiKey = await ensureApiKey();
  const env = {
    ...process.env,
    RELAY_API_KEY: apiKey,
    ...relayEnv,
  };

  const runner = new WorkflowRunner({
    cwd: workdir,
    relay: {
      binaryPath: resolveBinaryPath(),
      env,
    },
  });

  const events: Array<{ type: string; error?: string; stepName?: string }> = [];
  runner.on((event) => events.push(event as (typeof events)[0]));

  try {
    const run = await runner.execute(config, 'default');

    const stepFailed = events.find((e) => e.type === 'step:failed' && e.stepName === 'check');

    return {
      status: run.status,
      error: run.error,
      stepError: stepFailed?.error,
    };
  } catch (err: unknown) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Test 1: relay.env vars propagated to non-interactive subprocess ───────────
//
// A unique sentinel env var is set in relay.env but NOT in process.env.
// The agent asks claude to output its value. Before the fix, the sentinel was
// invisible to the subprocess (process.env spread only). After the fix,
// getRelayEnv() spreads relay.env into the subprocess env.

test(
  'non-interactive: relay.env vars reach subprocess (regression for env propagation bug)',
  { timeout: 180_000 },
  async (t) => {
    if (skipIfMissing(t) || skipIfNestedClaude(t) || skipIfNoClaude(t)) return;

    const workdir = createWorkdir();

    // Unique sentinel — deliberately NOT set in process.env, only in relay.env
    const sentinelKey = 'RELAY_NI_SUBPROCESS_TEST';
    const sentinelValue = `sentinel-${Date.now().toString(36)}`;

    // Temporarily ensure sentinel is absent from process.env
    const prevSentinel = process.env[sentinelKey];
    delete process.env[sentinelKey];

    try {
      const result = await runWorkflow(
        makeNonInteractiveConfig({
          task:
            `Check the environment variable named "${sentinelKey}". ` +
            `If it is set and non-empty, output exactly: SENTINEL=${sentinelValue} ` +
            `If it is missing or empty, output exactly: SENTINEL=NOT_FOUND`,
          verification: { type: 'output_contains', value: `SENTINEL=${sentinelValue}` },
          stepTimeoutMs: 120_000,
        }),
        workdir,
        { [sentinelKey]: sentinelValue }
      );

      assert.equal(
        result.status,
        'completed',
        `Workflow should complete — env var was not propagated to subprocess.\n` +
          `Error: ${result.error ?? result.stepError ?? '(none)'}`
      );
    } finally {
      if (prevSentinel !== undefined) process.env[sentinelKey] = prevSentinel;
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
);

// ── Test 2: Non-interactive agent with .mcp.json completes without hanging ────
//
// This reproduces the real-world stall: when RELAY_API_KEY was absent from the
// subprocess env, the relaycast MCP server started unauthenticated and could
// hang indefinitely, producing 0 bytes of output. The step timeout enforces a
// bound and after the fix the step should complete well within it.

test(
  'non-interactive: completes without hang when .mcp.json is present (regression for MCP stall)',
  { timeout: 180_000 },
  async (t) => {
    if (skipIfMissing(t) || skipIfNestedClaude(t) || skipIfNoClaude(t)) return;

    const workdir = createWorkdir();
    // Drop .mcp.json so claude loads the relaycast MCP server, exactly as in
    // the real failing workflow (tests/workflows/relay.clean-step-output.yaml).
    injectMcpJson(workdir);

    const start = Date.now();

    try {
      const result = await runWorkflow(
        makeNonInteractiveConfig({
          task: 'Output exactly: ANALYSIS_DONE',
          verification: { type: 'output_contains', value: 'ANALYSIS_DONE' },
          // Give 90 s — far more than needed for a trivial task; a genuine hang
          // would blow this ceiling and the test assertion catches the timeout.
          stepTimeoutMs: 90_000,
        }),
        workdir
      );

      const elapsed = Date.now() - start;

      assert.equal(
        result.status,
        'completed',
        `Workflow should complete quickly. After ${elapsed}ms got status="${result.status}". ` +
          `Error: ${result.error ?? result.stepError ?? '(none)'}\n` +
          `If this timed out, the MCP server likely hung because RELAY_API_KEY was missing ` +
          `from the subprocess env.`
      );

      // A task this simple (output one word) should finish in well under 60 s
      // even accounting for API latency. If it's taking longer, something is stuck.
      assert.ok(
        elapsed < 60_000,
        `Expected trivial task to finish in < 60 s, took ${elapsed}ms. ` +
          `Possible MCP stall — RELAY_API_KEY may not be reaching the subprocess.`
      );
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
);

// ── Test 3: Swarm-level timeoutMs enforced for non-interactive steps ──────────
//
// Before the fix, timeoutMs = step.timeoutMs ?? agentDef.constraints?.timeoutMs
// — the swarm.timeoutMs was never consulted for non-interactive steps, so a
// step with no explicit timeout ran with no deadline at all.
//
// After the fix the fallback chain includes swarm.timeoutMs and a 2 s swarm
// timeout kills the real claude subprocess before it can complete, producing a
// timeout error rather than hanging forever.

test(
  'non-interactive: swarm.timeoutMs enforced when no step or agent timeout set (regression)',
  { timeout: 60_000 },
  async (t) => {
    if (skipIfMissing(t) || skipIfNestedClaude(t) || skipIfNoClaude(t)) return;

    const workdir = createWorkdir();

    try {
      const result = await runWorkflow(
        makeNonInteractiveConfig({
          // Any non-trivial task — claude startup + API round-trip takes > 2 s,
          // so a 2 s swarm timeout should always fire before completion.
          task: 'Count from 1 to 1000 and print every number.',
          // Deliberately omit stepTimeoutMs and agentDef.constraints.timeoutMs
          // so only swarm.timeoutMs can enforce a deadline.
          swarmTimeoutMs: 2_000,
        }),
        workdir
      );

      assert.equal(
        result.status,
        'failed',
        `Expected step to fail with a timeout — swarm.timeoutMs was not enforced.\n` +
          `Got status="${result.status}". If "completed", the timeout was ignored.`
      );

      const errorText = result.error ?? result.stepError ?? '';
      assert.ok(
        errorText.toLowerCase().includes('timed out') || errorText.toLowerCase().includes('timeout'),
        `Expected a timeout error, got: "${errorText}"`
      );
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  }
);
