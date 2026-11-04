import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createDefaultAssignmentRunner } from './cloud-worker.js';
import {
  materializeCliCredentials,
  SUBSCRIPTION_LOGINS_ENV,
  writeBackCliCredentials,
} from './cloud-worker-cli-credentials.js';

const worker = {
  baseUrl: 'https://control.test',
  workerId: 'wrk_1',
  workerToken: 'sh_wrk_secret',
  name: 'w',
  heartbeatIntervalMs: 30_000,
  registeredAt: '2026-11-03T00:00:00.000Z',
  updatedAt: '2026-11-03T00:00:00.000Z',
} as never;

const CODEX = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-secret-1' } });
const GROK = JSON.stringify({ 'https://auth.x.ai::c': { key: 'k', refresh_token: 'xrt-secret' } });
const credentials = {
  ref: 'sh_clicred_ref',
  path: '/api/v1/workers/{workerId}/assignments/run_1/cli-credentials',
};

function controlPlane(files: unknown[]) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    if ((init.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ files, skipped: [] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ updated: true }), { headers: { 'content-type': 'application/json' } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const codexFile = {
  credentialId: 'c-codex',
  provider: 'openai',
  cli: 'codex',
  homeEnv: 'CODEX_HOME',
  directory: '.codex',
  file: 'auth.json',
  content: CODEX,
};

describe('cloud worker CLI logins', () => {
  it('writes each auth file 0600 in a 0700 dir inside the run dir and points the CLI at it', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-creds-'));
    try {
      const cp = controlPlane([
        codexFile,
        { ...codexFile, credentialId: 'c-grok', provider: 'xai', cli: 'grok', homeEnv: 'GROK_HOME', directory: '.grok', content: GROK },
        { ...codexFile, credentialId: 'evil', homeEnv: 'PATH' },
        { ...codexFile, credentialId: 'evil2', directory: '../../etc' },
      ]);
      const log = vi.fn();
      const materialized = await materializeCliCredentials({ worker, credentials, runDir, fetchImpl: cp.fetchImpl, log });
      expect(cp.calls[0]!.url).toBe('https://control.test/api/v1/workers/wrk_1/assignments/run_1/cli-credentials');
      expect(cp.calls[0]!.headers.get('authorization')).toBe('Bearer sh_wrk_secret');
      expect(cp.calls[0]!.headers.get('x-cli-credential-ref')).toBe('sh_clicred_ref');
      expect(materialized.env).toEqual({
        CODEX_HOME: path.join(runDir, '.cli-home', '.codex'),
        GROK_HOME: path.join(runDir, '.cli-home', '.grok'),
        [SUBSCRIPTION_LOGINS_ENV]: 'codex,grok',
      });
      const codexPath = path.join(runDir, '.cli-home', '.codex', 'auth.json');
      expect(fs.readFileSync(codexPath, 'utf-8')).toBe(CODEX);
      expect(fs.statSync(codexPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(codexPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(runDir, '.cli-home')).mode & 0o777).toBe(0o700);
      expect(materialized.files.map((file) => file.credentialId)).toEqual(['c-codex', 'c-grok']);
      expect(fs.existsSync(path.join(runDir, 'etc'))).toBe(false);
      expect(JSON.stringify(log.mock.calls)).not.toContain('rt-secret');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('refuses a reference path that leaves the control plane', async () => {
    const cp = controlPlane([]);
    await expect(
      materializeCliCredentials({
        worker,
        credentials: { ...credentials, path: 'https://evil.test/steal' },
        runDir: os.tmpdir(),
        fetchImpl: cp.fetchImpl,
      })
    ).rejects.toThrow(/relative \/api\//);
    expect(cp.calls).toHaveLength(0);
  });

  it('writes back only files the CLI changed', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-creds-'));
    try {
      const cp = controlPlane([codexFile, { ...codexFile, credentialId: 'c-grok', cli: 'grok', homeEnv: 'GROK_HOME', directory: '.grok', content: GROK }]);
      const materialized = await materializeCliCredentials({ worker, credentials, runDir, fetchImpl: cp.fetchImpl });
      const refreshed = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-secret-2' } });
      fs.writeFileSync(materialized.files[0]!.filePath, refreshed);
      expect(await writeBackCliCredentials({ worker, credentials, materialized, fetchImpl: cp.fetchImpl })).toBe(1);
      const put = cp.calls.find((call) => call.method === 'PUT')!;
      expect(put.url).toBe('https://control.test/api/v1/workers/wrk_1/assignments/run_1/cli-credentials/c-codex');
      expect(put.headers.get('x-cli-credential-ref')).toBe('sh_clicred_ref');
      expect(JSON.parse(put.body!)).toEqual({ content: refreshed });
      expect(cp.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('the assignment runner mounts logins for relayflows, writes back, and deletes the run dir', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-creds-home-'));
    try {
      const cp = controlPlane([codexFile]);
      let seenEnv: NodeJS.ProcessEnv = {};
      let fileDuringRun = '';
      const spawnProcess = vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        seenEnv = options.env;
        const authPath = path.join(options.env.CODEX_HOME!, 'auth.json');
        fileDuringRun = fs.readFileSync(authPath, 'utf-8');
        // The CLI refreshes its token during the run.
        fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-secret-3' } }));
        const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: () => boolean };
        child.killed = false;
        child.kill = () => true;
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      }) as never;
      const runner = createDefaultAssignmentRunner({
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
        env: { AGENT_RELAY_HOME: home, CODEX_HOME: '/home/user/.codex' },
        spawnProcess,
        now: () => new Date(),
        cwd: () => home,
        fetchImpl: cp.fetchImpl,
        resolveRelayflowsCliEntrypoint: () => '/opt/relayflows/dist/cli.js',
      });
      await runner({
        assignment: { runId: 'run_1' } as never,
        payload: {
          runId: 'run_1',
          workspaceId: 'ws',
          relayWorkspaceId: 'rw',
          relaycastApiKey: 'rk',
          relayfileUrl: '',
          relayfileToken: '',
          workflow: 'version: "1.0"\n',
          fileType: 'yaml',
          sourceFileType: 'yaml',
          workflowFileName: 'workflow.yaml',
          cliCredentials: credentials,
        },
        worker,
        signal: new AbortController().signal,
      });
      const runDir = path.join(home, 'cloud-workers', 'runs', 'run_1');
      expect(seenEnv.CODEX_HOME).toBe(path.join(runDir, '.cli-home', '.codex'));
      expect(seenEnv[SUBSCRIPTION_LOGINS_ENV]).toBe('codex');
      expect(fileDuringRun).toBe(CODEX);
      const put = cp.calls.find((call) => call.method === 'PUT');
      expect(JSON.parse(put!.body!).content).toContain('rt-secret-3');
      expect(fs.existsSync(runDir)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
