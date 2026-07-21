import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

import { HarnessDriverClient } from '@agent-relay/harness-driver';

import {
  BrokerHarness,
  checkPrerequisites,
  ensureApiKey,
  resolveBinaryPath,
  uniqueSuffix,
} from './utils/broker-harness.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function waitForNativeSessionReady(client: HarnessDriverClient, name: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = (await client.listAgents()).find((agent) => agent.name === name);
    if (!listed) {
      throw new Error(`Native agent ${name} disappeared before its session became ready`);
    }
    const history = await client.getAgentEventHistory(name);
    const failure = history.events.find((event) => event.event.kind === 'session.failed');
    if (failure) {
      throw new Error(`Native agent ${name} failed during startup: ${String(failure.event.error)}`);
    }
    if (history.events.some((event) => event.event.kind === 'session.started')) return listed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for native agent ${name} to become ready`);
}

async function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  bin?: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const entrypoint = path.join(repoRoot, 'packages', 'cli', 'dist', 'cli', 'index.js');
  const invocation = bin ?? [process.execPath, entrypoint];
  if (!bin) assert.equal(fs.existsSync(entrypoint), true, `CLI entrypoint not found at ${entrypoint}`);

  return new Promise((resolve, reject) => {
    const [command, ...prefix] = invocation;
    const child = spawn(command, [...prefix, ...args], {
      cwd,
      env: {
        ...process.env,
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'native-e2e-placeholder',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

test(
  'native harness: Bun standalone spawns an official adapter through the broker',
  { timeout: 45_000 },
  async (t) => {
    if (skipIfMissing(t)) return;
    const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (bun.error && 'code' in bun.error && bun.error.code === 'ENOENT') {
      t.skip('Bun is not installed');
      return;
    }
    assert.equal(bun.status, 0, bun.stderr);

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-standalone-e2e-'));
    const binary = path.join(cwd, process.platform === 'win32' ? 'agent-relay.exe' : 'agent-relay');
    const name = `native-standalone-${uniqueSuffix()}`;
    let client: HarnessDriverClient | undefined;
    try {
      const compiled = spawnSync(
        'bun',
        ['build', '--compile', '--minify', 'packages/cli/dist/cli/index.js', '--outfile', binary],
        { cwd: repoRoot, encoding: 'utf8', timeout: 20_000 }
      );
      assert.equal(compiled.status, 0, `Standalone compile failed:\n${compiled.stderr}`);

      const apiKey = await ensureApiKey();
      const started = await runCli(
        cwd,
        ['node', 'up', '--background', '--no-spawn'],
        {
          AGENT_RELAY_BIN: resolveBinaryPath(),
          RELAY_API_KEY: apiKey,
        },
        [binary]
      );
      assert.equal(started.exitCode, 0, `Standalone broker startup failed:\n${started.stderr}`);
      client = await eventually(async () => {
        try {
          return HarnessDriverClient.connect({ cwd });
        } catch {
          return undefined;
        }
      });

      const spawned = await runCli(
        cwd,
        [
          'node',
          'agent',
          'spawn',
          'pi',
          '--runtime',
          'native',
          '--name',
          name,
          '--model',
          'openai/gpt-4o-mini',
          '--cwd',
          cwd,
        ],
        {},
        [binary]
      );
      assert.equal(spawned.exitCode, 0, `Standalone native spawn failed:\n${spawned.stderr}`);
      assert.match(spawned.stdout, /\(pi, native\)/);

      const listed = await eventually(async () =>
        (await client!.listAgents()).find((agent) => agent.name === name)
      );
      assert.equal(listed.runtime_kind, 'native');
      assert.equal(listed.native_harness_protocol_version, 1);
      await client.release(name);
    } finally {
      await client?.shutdown().catch(() => {});
      client?.disconnect();
      await eventually(async () => {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
          return true;
        } catch {
          return undefined;
        }
      });
    }
  }
);

test(
  'native harness: CLI generates and launches the AI SDK sidecar contract',
  { timeout: 30_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-cli-e2e-'));
    const name = `native-cli-${uniqueSuffix()}`;
    let client: HarnessDriverClient | undefined;

    try {
      const apiKey = await ensureApiKey();
      const started = await runCli(cwd, ['node', 'up', '--background', '--no-spawn'], {
        AGENT_RELAY_BIN: resolveBinaryPath(),
        RELAY_API_KEY: apiKey,
      });
      assert.equal(started.exitCode, 0, `CLI broker startup failed:\n${started.stderr}`);
      client = await eventually(async () => {
        try {
          return HarnessDriverClient.connect({ cwd });
        } catch {
          return undefined;
        }
      });

      const result = await runCli(cwd, [
        'node',
        'agent',
        'spawn',
        'pi',
        '--runtime',
        'native',
        '--name',
        name,
        '--model',
        'openai/gpt-4o-mini',
        '--cwd',
        cwd,
      ]);
      assert.equal(result.exitCode, 0, `CLI failed:\n${result.stderr}`);
      assert.match(result.stdout, /\(pi, native\)/);

      const listed = await eventually(async () =>
        (await client!.listAgents()).find((agent) => agent.name === name)
      );
      assert.equal(listed.runtime_kind, 'native');
      assert.equal(listed.native_harness_protocol_version, 1);

      await client.release(name);
    } finally {
      await client?.shutdown().catch(() => {});
      client?.disconnect();
      await eventually(async () => {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
          return true;
        } catch {
          return undefined;
        }
      });
    }
  }
);

test(
  'native harness: Codex adapter bootstraps and stays registered after readiness',
  { timeout: 150_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-native-codex-e2e-'));
    const name = `native-codex-${uniqueSuffix()}`;
    let client: HarnessDriverClient | undefined;

    try {
      // Reproduce a normal Relay checkout: Corepack sees npm at the project
      // root while the official Codex adapter bootstraps its pinned pnpm bridge
      // under /tmp/harness/codex.
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ private: true, packageManager: 'npm@10.9.8' })
      );
      const apiKey = await ensureApiKey();
      const started = await runCli(cwd, ['node', 'up', '--background', '--no-spawn'], {
        AGENT_RELAY_BIN: resolveBinaryPath(),
        RELAY_API_KEY: apiKey,
      });
      assert.equal(started.exitCode, 0, `CLI broker startup failed:\n${started.stderr}`);
      client = await eventually(async () => {
        try {
          return HarnessDriverClient.connect({ cwd });
        } catch {
          return undefined;
        }
      });

      const result = await runCli(cwd, [
        'node',
        'agent',
        'spawn',
        'codex',
        '--runtime',
        'native',
        '--name',
        name,
        '--cwd',
        cwd,
      ]);
      assert.equal(result.exitCode, 0, `CLI failed:\n${result.stderr}`);
      assert.match(result.stdout, /\(codex, native\)/);

      const listed = await waitForNativeSessionReady(client, name);
      assert.equal(listed.runtime_kind, 'native');
      assert.equal(listed.native_harness_protocol_version, 1);
      assert.equal(
        (await client.listAgents()).some((agent) => agent.name === name),
        true
      );

      await client.release(name);
    } finally {
      await client?.shutdown().catch(() => {});
      client?.disconnect();
      await eventually(async () => {
        try {
          fs.rmSync(cwd, { recursive: true, force: true });
          return true;
        } catch {
          return undefined;
        }
      });
    }
  }
);

test('native harness: broker spawn, events, commands, and release', { timeout: 30_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new BrokerHarness();
  await harness.start();
  const name = `native-e2e-${uniqueSuffix()}`;
  const fixture = fileURLToPath(new URL('./fixtures/native-sidecar.js', import.meta.url));

  try {
    const spawned = await harness.client.spawnHeadless({
      name,
      // The broker's public headless allowlist is provider-based; the native
      // harness config below replaces the provider command with our fixture.
      cli: 'codex',
      channels: ['general'],
      harnessConfig: {
        runtime: 'native',
        command: process.execPath,
        args: [fixture],
        sessionId: `native-${uniqueSuffix()}`,
        metadata: {
          runtimeKind: 'native',
          nativeHarnessProtocolVersion: 1,
          nativeHarnessCapabilities: { activeInput: true },
        },
      },
    });
    assert.equal(spawned.name, name);
    assert.equal(spawned.runtime, 'headless');

    const listed = await eventually(async () =>
      (await harness.listAgents()).find((agent) => agent.name === name)
    );
    assert.equal(listed.runtime_kind, 'native');
    assert.equal(listed.native_harness_protocol_version, 1);

    const starting = await eventually(async () => {
      const history = await harness.client.getAgentEventHistory(name);
      return history.events.find(
        (entry) => entry.event.kind === 'activity.changed' && entry.event.activity === 'starting'
      );
    });
    assert.equal(starting.name, name);

    const acknowledgement = await harness.client.sendNativeHarnessCommand(name, {
      kind: 'submit_user_message',
      idempotency_key: `command-${uniqueSuffix()}`,
      text: 'hello native',
      mode: 'auto',
    });
    assert.equal(acknowledgement.accepted, true);

    const delta = await eventually(async () => {
      const history = await harness.client.getAgentEventHistory(name);
      return history.events.find(
        (entry) => entry.event.kind === 'text.delta' && entry.event.delta === 'echo:hello native'
      );
    });
    assert.equal(delta.event.kind, 'text.delta');

    await harness.releaseAgent(name);
    await eventually(async () =>
      harness
        .getEvents()
        .find(
          (event) =>
            (event.kind === 'agent_released' || event.kind === 'agent_exited') &&
            'name' in event &&
            event.name === name
        )
    );
  } finally {
    await harness.stop();
  }
});
