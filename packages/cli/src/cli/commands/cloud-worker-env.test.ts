import { describe, expect, it } from 'vitest';
import type { WorkerWorkflowPayload } from '@agent-relay/cloud';
import { buildWorkerRuntimeEnv, type CloudWorkerDependencies } from './cloud-worker.js';

const base: WorkerWorkflowPayload = {
  runId: 'run_env',
  workspaceId: 'ws_1',
  relayWorkspaceId: 'rw_1',
  relaycastApiKey: 'rk_live_secret',
  relayfileUrl: 'https://relayfile.test',
  relayfileToken: 'relayfile_secret',
  workflow: 'version: "0.1.0"\nname: env\nsteps: []\n',
  fileType: 'yaml',
  sourceFileType: 'yaml',
  workflowFileName: 'workflow.yaml',
};
const stale = { RELAYFILE_URL: 'https://stale.test', RELAYFILE_TOKEN: 'stale_token', BASE_ENV: 'kept' };
const deps = { env: stale } as unknown as CloudWorkerDependencies;

describe('buildWorkerRuntimeEnv Relayfile settings', () => {
  it('passes the per-run Relayfile URL and token when both are present', () => {
    const env = buildWorkerRuntimeEnv(base, deps);
    expect(env).toMatchObject({
      BASE_ENV: 'kept',
      RELAYFILE_URL: 'https://relayfile.test',
      RELAYFILE_TOKEN: 'relayfile_secret',
    });
  });

  it.each([
    ['omitted', { relayfileToken: undefined }],
    ['empty', { relayfileToken: '' }],
    ['with an empty URL (self-host)', { relayfileToken: undefined, relayfileUrl: '' }],
  ])('sets neither key when the token is %s, even if inherited or in envSecrets', (_label, change) => {
    const payload = {
      ...base,
      ...change,
      envSecrets: { RELAYFILE_URL: 'https://secret.test', RELAYFILE_TOKEN: 'secret_token' },
    };
    const env = buildWorkerRuntimeEnv(payload as WorkerWorkflowPayload, deps);
    expect(env).not.toHaveProperty('RELAYFILE_URL');
    expect(env).not.toHaveProperty('RELAYFILE_TOKEN');
    expect(env.BASE_ENV).toBe('kept');
    expect(env.RELAY_API_KEY).toBe('rk_live_secret');
  });
});
