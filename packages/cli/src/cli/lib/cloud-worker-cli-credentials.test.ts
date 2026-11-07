import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultAssignmentRunner } from '../commands/cloud-worker.js';
import {
  cliLoginHome,
  materializeCliCredentials,
  removeLoginHome,
  SUBSCRIPTION_LOGINS_ENV,
  writeBackCliCredentials,
} from './cloud-worker-cli-credentials.js';

const posix = process.platform !== 'win32';

function workerFor(baseUrl = 'https://control.test') {
  return {
    baseUrl,
    workerId: 'wrk_1',
    workerToken: 'sh_wrk_secret',
    name: 'w',
    heartbeatIntervalMs: 30_000,
    registeredAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
  } as never;
}
const worker = workerFor();

const CODEX = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-secret-1' } });
const GROK = JSON.stringify({ 'https://auth.x.ai::c': { key: 'k', refresh_token: 'xrt-secret' } });
const credentials = {
  ref: 'sh_clicred_ref',
  path: '/api/v1/workers/{workerId}/assignments/run_1/cli-credentials',
  credentials: [
    { credentialId: 'c-codex', provider: 'openai', cli: 'codex' },
    { credentialId: 'c-grok', provider: 'xai', cli: 'grok' },
  ],
};

const codexFile = {
  credentialId: 'c-codex',
  provider: 'openai',
  cli: 'codex',
  homeEnv: 'CODEX_HOME',
  directory: '.codex',
  file: 'auth.json',
  content: CODEX,
};
const grokFile = {
  credentialId: 'c-grok',
  provider: 'xai',
  cli: 'grok',
  homeEnv: 'GROK_HOME',
  directory: '.grok',
  file: 'auth.json',
  content: GROK,
};

function controlPlane(files: unknown[], putStatus = 200) {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    if ((init.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ files, skipped: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ updated: putStatus === 200 }), {
      status: putStatus,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

// Each run dir lives in its own temp parent, so the sibling login dir is
// removed with it after every test.
const tempParents: string[] = [];
function tmp(prefix: string) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempParents.push(parent);
  // <parent>/runs/run, so the login dir (<parent>/cli-logins/run) stays inside the parent.
  const runDir = path.join(parent, 'runs', 'run');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  return runDir;
}
afterEach(() => {
  for (const parent of tempParents.splice(0)) fs.rmSync(parent, { recursive: true, force: true });
});

describe('cloud worker CLI logins', () => {
  it('writes each auth file 0600 in a 0700 dir inside the run dir and points the CLI at it', async () => {
    const runDir = tmp('cli-creds-');
    try {
      const cp = controlPlane([codexFile, grokFile]);
      const log = vi.fn();
      const materialized = await materializeCliCredentials({
        worker,
        credentials,
        runDir,
        fetchImpl: cp.fetchImpl,
        log,
      });
      expect(cp.calls[0]!.url).toBe(
        'https://control.test/api/v1/workers/wrk_1/assignments/run_1/cli-credentials'
      );
      expect(cp.calls[0]!.headers.get('authorization')).toBe('Bearer sh_wrk_secret');
      expect(cp.calls[0]!.headers.get('x-cli-credential-ref')).toBe('sh_clicred_ref');
      expect(materialized.home).toBe(cliLoginHome(runDir));
      expect(materialized.env).toEqual({
        CODEX_HOME: path.join(cliLoginHome(runDir), '.codex'),
        GROK_HOME: path.join(cliLoginHome(runDir), '.grok'),
        [SUBSCRIPTION_LOGINS_ENV]: 'codex,grok',
      });
      const codexPath = path.join(cliLoginHome(runDir), '.codex', 'auth.json');
      expect(fs.readFileSync(codexPath, 'utf-8')).toBe(CODEX);
      if (posix) {
        expect(fs.statSync(codexPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.join(cliLoginHome(runDir), '.grok', 'auth.json')).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(codexPath)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(cliLoginHome(runDir)).mode & 0o777).toBe(0o700);
      }
      expect(JSON.stringify(log.mock.calls)).not.toContain('rt-secret');
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('mounts only files that match a credential the assignment listed, with its own CLI layout', async () => {
    const runDir = tmp('cli-creds-');
    try {
      const cp = controlPlane([
        { ...codexFile, homeEnv: 'GROK_HOME', directory: '.grok' },
        { ...codexFile, credentialId: 'c-grok' },
        { ...codexFile, credentialId: 'not-listed' },
        { ...codexFile, homeEnv: 'PATH' },
        { ...codexFile, directory: '../../etc' },
        { ...codexFile, cli: 'claude' },
      ]);
      const materialized = await materializeCliCredentials({
        worker,
        credentials,
        runDir,
        fetchImpl: cp.fetchImpl,
      });
      expect(materialized.files).toEqual([]);
      // No login mounted: each CLI home is an empty run-scoped dir, never the host's.
      expect(materialized.env).toEqual({
        CODEX_HOME: path.join(cliLoginHome(runDir), '.codex'),
        GROK_HOME: path.join(cliLoginHome(runDir), '.grok'),
        [SUBSCRIPTION_LOGINS_ENV]: '',
      });
      expect(fs.readdirSync(path.join(cliLoginHome(runDir), '.grok'))).toEqual([]);
      expect(fs.existsSync(path.join(runDir, 'etc'))).toBe(false);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('keeps the base path prefix and refuses any path but the credential route', async () => {
    const runDir = tmp('cli-creds-');
    try {
      const prefixed = controlPlane([codexFile]);
      await materializeCliCredentials({
        worker: workerFor('https://agentrelay.test/cloud/'),
        credentials,
        runDir,
        fetchImpl: prefixed.fetchImpl,
      });
      expect(prefixed.calls[0]!.url).toBe(
        'https://agentrelay.test/cloud/api/v1/workers/wrk_1/assignments/run_1/cli-credentials'
      );
      for (const hostile of [
        'https://evil.test/steal',
        '/api/\\evil.example/x',
        '/api/v1/workers/{workerId}/assignments/run_1/../../../admin',
        '/api/v1/workers/{workerId}/assignments/run_1/cli-credentials?x=1',
        '//evil.test/api/v1/workers/{workerId}/assignments/run_1/cli-credentials',
      ]) {
        const cp = controlPlane([]);
        await expect(
          materializeCliCredentials({
            worker,
            credentials: { ...credentials, path: hostile },
            runDir,
            fetchImpl: cp.fetchImpl,
          })
        ).rejects.toThrow(/credential route/);
        expect(cp.calls).toHaveLength(0);
      }
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('writes back only changed regular files, never through a symlink', async () => {
    const runDir = tmp('cli-creds-');
    try {
      const cp = controlPlane([codexFile, grokFile]);
      const materialized = await materializeCliCredentials({
        worker,
        credentials,
        runDir,
        fetchImpl: cp.fetchImpl,
      });
      const refreshed = JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-secret-2' } });
      fs.writeFileSync(materialized.files[0]!.filePath, refreshed);
      if (posix) {
        const secret = path.join(runDir, 'host-secret.txt');
        fs.writeFileSync(secret, 'not a login');
        fs.rmSync(materialized.files[1]!.filePath);
        fs.symlinkSync(secret, materialized.files[1]!.filePath);
      }
      const outcome = await writeBackCliCredentials({
        worker,
        credentials,
        materialized,
        fetchImpl: cp.fetchImpl,
      });
      expect(outcome).toEqual({ written: 1, failed: [] });
      const puts = cp.calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(puts[0]!.url).toBe(
        'https://control.test/api/v1/workers/wrk_1/assignments/run_1/cli-credentials/c-codex'
      );
      expect(puts[0]!.headers.get('x-cli-credential-ref')).toBe('sh_clicred_ref');
      expect(JSON.parse(puts[0]!.body!)).toEqual({ content: refreshed });
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('retries a failed write-back and reports it when it cannot be stored', async () => {
    const runDir = tmp('cli-creds-');
    try {
      const cp = controlPlane([codexFile], 503);
      const materialized = await materializeCliCredentials({
        worker,
        credentials,
        runDir,
        fetchImpl: cp.fetchImpl,
      });
      fs.writeFileSync(materialized.files[0]!.filePath, '{"changed":true}');
      const outcome = await writeBackCliCredentials({
        worker,
        credentials,
        materialized,
        fetchImpl: cp.fetchImpl,
        retryDelayMs: 1,
      });
      expect(outcome).toEqual({ written: 0, failed: [{ credentialId: 'c-codex', cli: 'codex' }] });
      expect(cp.calls.filter((call) => call.method === 'PUT')).toHaveLength(3);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('the assignment runner mounts logins for relayflows, writes back, and removes the logins', async () => {
    const home = tmp('cli-creds-home-');
    try {
      const cp = controlPlane([codexFile]);
      let seenEnv: NodeJS.ProcessEnv = {};
      let fileDuringRun = '';
      const spawnProcess = vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        seenEnv = options.env;
        const authPath = path.join(options.env.CODEX_HOME!, 'auth.json');
        fileDuringRun = fs.readFileSync(authPath, 'utf-8');
        // The CLI refreshes its token during the run.
        fs.writeFileSync(
          authPath,
          JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-secret-3' } })
        );
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
        // The run dir is kept, but the logins must still be removed.
        env: {
          AGENT_RELAY_HOME: home,
          CODEX_HOME: '/home/user/.codex',
          AGENT_RELAY_WORKER_KEEP_RUN_DIR: '1',
        },
        spawnProcess,
        now: () => new Date(),
        cwd: () => home,
        fetchImpl: cp.fetchImpl,
        resolveRelayflowsCliEntrypoint: () => '/opt/relayflows/dist/cli.js',
      });
      const result = await runner({
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
      expect(seenEnv.CODEX_HOME).toBe(path.join(cliLoginHome(runDir), '.codex'));
      expect(seenEnv[SUBSCRIPTION_LOGINS_ENV]).toBe('codex');
      expect(fileDuringRun).toBe(CODEX);
      const puts = cp.calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(JSON.parse(puts[0]!.body!).content).toContain('rt-secret-3');
      expect(result.summary).toBe('Workflow run_1 completed.');
      expect(fs.existsSync(runDir)).toBe(true);
      expect(fs.existsSync(cliLoginHome(runDir))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails clearly when the reference has no credential list, and skips malformed entries', async () => {
    const runDir = tmp('cli-creds-');
    try {
      const cp = controlPlane([codexFile]);
      await expect(
        materializeCliCredentials({
          worker,
          credentials: { ref: credentials.ref, path: credentials.path },
          runDir,
          fetchImpl: cp.fetchImpl,
        })
      ).rejects.toThrow(/must list the CLI logins/);
      const malformed = controlPlane([null, 7, codexFile]);
      const materialized = await materializeCliCredentials({
        worker,
        credentials,
        runDir,
        fetchImpl: malformed.fetchImpl,
      });
      expect(materialized.files.map((file) => file.credentialId)).toEqual(['c-codex']);
      expect(materialized.env[SUBSCRIPTION_LOGINS_ENV]).toBe('codex');
      expect(materialized.env.GROK_HOME).toBe(path.join(cliLoginHome(runDir), '.grok'));
      // The list is checked before any request; an unreadable response fails the run.
      expect(cp.calls).toHaveLength(0);
      const html = vi.fn(
        async () => new Response('<html>oops</html>', { status: 200 })
      ) as unknown as typeof fetch;
      await expect(
        materializeCliCredentials({ worker, credentials, runDir, fetchImpl: html })
      ).rejects.toThrow(/unreadable/);
      const shapeless = vi.fn(
        async () => new Response('{"files":"nope"}', { status: 200 })
      ) as unknown as typeof fetch;
      await expect(
        materializeCliCredentials({ worker, credentials, runDir, fetchImpl: shapeless })
      ).rejects.toThrow(/invalid/);
      const proto = controlPlane([
        { ...codexFile, cli: '__proto__' },
        { ...codexFile, cli: 'toString' },
      ]);
      expect(
        (await materializeCliCredentials({ worker, credentials, runDir, fetchImpl: proto.fetchImpl })).files
      ).toEqual([]);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('never writes a login through a symlink planted in the run dir', async () => {
    if (!posix) return;
    const runDir = tmp('cli-creds-');
    const outside = tmp('cli-creds-outside-');
    try {
      fs.mkdirSync(path.dirname(cliLoginHome(runDir)), { recursive: true });
      fs.symlinkSync(outside, cliLoginHome(runDir));
      const cp = controlPlane([codexFile]);
      const materialized = await materializeCliCredentials({
        worker,
        credentials,
        runDir,
        fetchImpl: cp.fetchImpl,
      });
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.lstatSync(cliLoginHome(runDir)).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(materialized.files[0]!.filePath, 'utf-8')).toBe(CODEX);
    } finally {
      fs.rmSync(cliLoginHome(runDir), { recursive: true, force: true });
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes the login dir and reports an unstored login when the run fails', async () => {
    const home = tmp('cli-creds-home-');
    try {
      const cp = controlPlane([codexFile], 400);
      const spawnProcess = vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        fs.writeFileSync(path.join(options.env.CODEX_HOME!, 'auth.json'), '{"refreshed":true}');
        const child = new EventEmitter() as EventEmitter & { killed: boolean; kill: () => boolean };
        child.killed = false;
        child.kill = () => true;
        queueMicrotask(() => child.emit('exit', 1, null));
        return child;
      }) as never;
      const runner = createDefaultAssignmentRunner({
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn() as never,
        env: { AGENT_RELAY_HOME: home, AGENT_RELAY_WORKER_KEEP_RUN_DIR: '1' },
        spawnProcess,
        now: () => new Date(),
        cwd: () => home,
        fetchImpl: cp.fetchImpl,
        resolveRelayflowsCliEntrypoint: () => '/opt/relayflows/dist/cli.js',
      });
      await expect(
        runner({
          assignment: { runId: 'run_2' } as never,
          payload: {
            runId: 'run_2',
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
        })
      ).rejects.toThrow(/exited with code 1.*codex login could not be stored/);
      expect(fs.existsSync(cliLoginHome(path.join(home, 'cloud-workers', 'runs', 'run_2')))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('removes a login dir the workflow made unreadable', async () => {
    if (!posix || process.getuid?.() === 0) return;
    const runDir = tmp('cli-creds-');
    const cp = controlPlane([codexFile]);
    const materialized = await materializeCliCredentials({
      worker,
      credentials,
      runDir,
      fetchImpl: cp.fetchImpl,
    });
    fs.chmodSync(path.join(materialized.home, '.codex'), 0o000);
    await removeLoginHome(materialized.home);
    expect(fs.existsSync(materialized.home)).toBe(false);
    expect(materialized.home).toBe(path.join(path.dirname(path.dirname(runDir)), 'cli-logins', 'run'));
  });
});
