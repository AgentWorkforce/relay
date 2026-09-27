import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@agent-relay/harness-driver', () => ({ HarnessDriverClient: { spawn } }));
vi.mock('@agent-relay/harnesses', () => ({ resolveHarnessRuntime: vi.fn(), createNativeHarnessLaunch: vi.fn() }));

import { createRuntimeClient } from '../packages/cli/src/cli/lib/client-factory.js';
import { getBrokerBinaryPath } from '../packages/harness-driver/src/broker-path.js';

const originalEnv = { ...process.env };
const temporary = mkdtempSync(path.join(os.tmpdir(), 'relay-1451-proof-'));
afterEach(() => { process.env = { ...originalEnv }; rmSync(temporary, { recursive: true, force: true }); });

it('does not route the old CLI binary into a broker spawn', async () => {
  const cli = path.join(temporary, 'agent-relay');
  writeFileSync(cli, '#!/bin/sh\nexit 0\n');
  chmodSync(cli, 0o755);
  process.env.BROKER_BINARY_PATH = path.join(temporary, 'agent-relay-broker');
  process.env.AGENT_RELAY_BIN = cli;
  await createRuntimeClient({ cwd: temporary });
  const forwarded = spawn.mock.calls.at(-1)?.[0] as { binaryPath?: string };
  expect(forwarded).toBeDefined();
  if (forwarded.binaryPath === cli) {
    console.log('PROOF:spawns_cli_override');
  } else {
    expect(forwarded.binaryPath).toBeUndefined();
    process.env.BROKER_BINARY_PATH = cli;
    expect(() => getBrokerBinaryPath()).toThrow(/BROKER_BINARY_PATH must point to an agent-relay-broker executable/u);
    console.log('PROOF:rejects_cli_override');
  }
});
