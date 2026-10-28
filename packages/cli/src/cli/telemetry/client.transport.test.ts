import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeStoredIdentity } from '@agent-relay/cloud/identity';
import { initTelemetry, shutdown, track } from './client.js';
import { disableTelemetry } from './config.js';

interface CapturedTelemetryEvent {
  distinct_id?: string;
  event?: string;
  properties?: Record<string, unknown>;
}

interface CapturedTelemetryBatch {
  batch: CapturedTelemetryEvent[];
}

function capturedBatch(value: unknown): CapturedTelemetryBatch {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { batch?: unknown }).batch)) {
    throw new Error('telemetry transport did not send a batch');
  }
  return value as CapturedTelemetryBatch;
}

let dataDir: string;
let batches: CapturedTelemetryBatch[];
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wire-'));
  batches = [];
  vi.stubEnv('AGENT_RELAY_DATA_DIR', dataDir);
  vi.stubEnv('POSTHOG_API_KEY', 'synthetic-test-key');
  vi.stubEnv('AGENT_RELAY_TELEMETRY_DISABLED', '');
  vi.stubEnv('DO_NOT_TRACK', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const raw =
        typeof init.body === 'string'
          ? init.body
          : gunzipSync(
              init.body instanceof Blob ? Buffer.from(await init.body.arrayBuffer()) : init.body
            ).toString();
      batches.push(capturedBatch(JSON.parse(raw)));
      return new Response('{}', { status: 200 });
    })
  );
});
afterEach(async () => {
  await shutdown();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

it('serializes canonical person and workspace after in-process login with the installed SDK', async () => {
  initTelemetry({ showNotice: false, cliVersion: 'synthetic' });
  await writeStoredIdentity({
    userId: 'usr_A',
    email: 'synthetic@example.test',
    name: 'Synthetic',
    workspaceId: 'ws_A',
    apiUrl: 'https://example.test',
    updatedAt: new Date().toISOString(),
  });
  track('cli_cloud_auth_command', { action: 'login', success: true, duration_ms: 1 });
  await shutdown();
  const events = batches.flatMap((batch) => batch.batch);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    distinct_id: 'usr_A',
    event: 'cli_cloud_auth_command',
    properties: {
      $groups: { workspace: 'ws_A' },
      analytics_contract_version: 2,
      emitter: 'relay-cli',
      identity_source: 'cloud_session',
    },
  });
  expect(JSON.stringify(batches)).not.toContain('synthetic@example.test');
});

it('drops the installed SDK queue when opt-out occurs before shutdown', async () => {
  initTelemetry({ showNotice: false });
  track('cli_command_run', { command_name: 'status' });
  disableTelemetry();
  await shutdown();
  expect(batches).toEqual([]);
});
