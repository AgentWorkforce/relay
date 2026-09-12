import fs from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type RelaycastCredential,
  readWorkspaceStore,
  readRelaycastCredential,
  relaycastCredentialRef,
  relaycastCredentialStorePath,
  resolveActiveWorkspaceKey,
  setActiveWorkspace,
  setWorkspaceKey,
  workspaceStorePath,
  writeRelaycastCredential,
} from './workspace-store.js';

let dir: string;
const original = process.env.AGENT_RELAY_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ws-'));
  process.env.AGENT_RELAY_HOME = dir;
});

afterEach(() => {
  if (original === undefined) delete process.env.AGENT_RELAY_HOME;
  else process.env.AGENT_RELAY_HOME = original;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace store', () => {
  it('stores keys, sets the first as active, and resolves the active key', () => {
    setWorkspaceKey('ops', 'rk_ops');
    expect(resolveActiveWorkspaceKey()).toBe('rk_ops');

    setWorkspaceKey('support', 'rk_support');
    expect(readWorkspaceStore().active).toBe('ops');

    setActiveWorkspace('support');
    expect(resolveActiveWorkspaceKey()).toBe('rk_support');
    expect(readWorkspaceStore().previous).toBe('ops');
  });

  it('records only genuine active-workspace changes', () => {
    setWorkspaceKey('ops', 'rk_ops');
    setActiveWorkspace('ops');
    expect(readWorkspaceStore().previous).toBeUndefined();

    setWorkspaceKey('support', 'rk_support');
    setActiveWorkspace('support');
    expect(readWorkspaceStore()).toMatchObject({ active: 'support', previous: 'ops' });

    setActiveWorkspace('support');
    expect(readWorkspaceStore()).toMatchObject({ active: 'support', previous: 'ops' });
  });

  it('throws when switching to an unknown workspace', () => {
    expect(() => setActiveWorkspace('nope')).toThrow(/Unknown workspace/);
  });

  it('writes the store with owner-only permissions', () => {
    setWorkspaceKey('ops', 'rk_ops');
    const mode = fs.statSync(workspaceStorePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('stores route credentials outside the project with a scoped reference', () => {
    const ref = relaycastCredentialRef(
      '/checkout/.agentworkforce/relay',
      'rw_abc',
      'agent37-isolated',
      'https://agent37-cast.agentrelay.com'
    );
    writeRelaycastCredential(ref, {
      workspaceId: 'rw_abc',
      route: 'agent37-isolated',
      baseUrl: 'https://agent37-cast.agentrelay.com',
      apiKey: 'rk_live_route',
    });
    expect(readRelaycastCredential(ref)).toMatchObject({ workspaceId: 'rw_abc', apiKey: 'rk_live_route' });
    expect(fs.statSync(relaycastCredentialStorePath()).mode & 0o777).toBe(0o600);
  });

  it('preserves concurrent credential writes and never exposes a partial JSON read', async () => {
    writeRelaycastCredential('sentinel', {
      workspaceId: 'rw_sentinel',
      route: 'canonical',
      baseUrl: 'https://relay.example',
      apiKey: 'rk_live_sentinel',
    });
    const source = fs.readFileSync(new URL('./workspace-store.ts', import.meta.url), 'utf8');
    const worker = path.join(dir, 'workspace-store-worker.mjs');
    fs.writeFileSync(
      worker,
      `${
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
        }).outputText
      }\n${[
        'const mode = process.argv[2];',
        'const id = process.argv[3] ?? "reader";',
        'if (mode === "reader") {',
        '  for (let index = 0; index < 500; index += 1) {',
        '    if (!readRelaycastCredential("sentinel")) process.exit(3);',
        '  }',
        '  process.exit(0);',
        '}',
        'for (let index = 0; index < 12; index += 1) {',
        '  writeRelaycastCredential(`${id}-${index}`, { workspaceId: `${id}-${index}`, route: "canonical", baseUrl: "https://relay.example", apiKey: `rk_live_${id}_${index}` });',
        '}',
        'process.exit(0);',
      ].join('\n')}`,
      { mode: 0o600 }
    );

    const run = (mode: 'reader' | 'writer', id: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, mode, id], {
          env: { AGENT_RELAY_HOME: dir, NODE_ENV: 'test' },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`credential ${mode} worker ${id} exited ${code}: ${stderr}`));
        });
      });

    const results = await Promise.allSettled([
      ...Array.from({ length: 8 }, (_, index) => run('writer', `writer-${index}`)),
      run('reader', 'reader-a'),
      run('reader', 'reader-b'),
    ]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;

    const stored = JSON.parse(fs.readFileSync(relaycastCredentialStorePath(), 'utf8')) as {
      credentials: Record<string, RelaycastCredential>;
    };
    expect(Object.keys(stored.credentials)).toHaveLength(1 + 8 * 12);
    expect(stored.credentials.sentinel.apiKey).toBe('rk_live_sentinel');
    expect(readRelaycastCredential('writer-7-11')?.apiKey).toBe('rk_live_writer-7_11');
  }, 30_000);

  it('reclaims a stale credential lock left by an exited writer', () => {
    const lock = `${relaycastCredentialStorePath()}.lock`;
    const token = 'dead-owner-token';
    fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lock, token), JSON.stringify({ version: 1, pid: 999_999_999, token }), {
      mode: 0o600,
      flag: 'wx',
    });
    const staleAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, staleAt, staleAt);

    writeRelaycastCredential('after-stale-lock', {
      workspaceId: 'rw_after_stale',
      route: 'canonical',
      baseUrl: 'https://relay.example',
      apiKey: 'rk_live_after_stale',
    });

    expect(readRelaycastCredential('after-stale-lock')?.apiKey).toBe('rk_live_after_stale');
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('refuses to inspect or clean a stale credential lock symlink', () => {
    const lock = `${relaycastCredentialStorePath()}.lock`;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-target-'));
    const sentinel = path.join(outside, 'keep.txt');
    fs.writeFileSync(sentinel, 'keep');
    fs.symlinkSync(outside, lock, 'dir');
    const staleAt = new Date(Date.now() - 60_000);
    fs.lutimesSync(lock, staleAt, staleAt);

    expect(() =>
      writeRelaycastCredential('must-fail-closed', {
        workspaceId: 'rw_must_fail_closed',
        route: 'canonical',
        baseUrl: 'https://relay.example',
        apiKey: 'rk_live_must_fail_closed',
      })
    ).toThrow(/real directory/);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
  });

  it('scopes route references to the selected endpoint', () => {
    expect(
      relaycastCredentialRef(
        '/checkout/.agentworkforce/relay',
        'rw_abc',
        'agent37-isolated',
        'https://one.example'
      )
    ).not.toBe(
      relaycastCredentialRef(
        '/checkout/.agentworkforce/relay',
        'rw_abc',
        'agent37-isolated',
        'https://two.example'
      )
    );
  });

  it('rejects reserved object-property workspace names', () => {
    expect(() => setWorkspaceKey('__proto__', 'rk_bad')).toThrow(/Invalid workspace name/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
