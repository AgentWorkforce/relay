import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { boundOrigin } from '../lib/relaycast-origin-binding.js';
import { readWorkspaceStore } from '../lib/workspace-store.js';
import { registerInitCommand, type InitCommandDependencies } from './init.js';

let home: string;
let project: string;

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-init-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-init-project-'));
  vi.stubEnv('AGENT_RELAY_HOME', home);
  vi.stubEnv('AGENT_RELAY_PROJECT', project);
  vi.stubEnv('RELAY_BASE_URL', '');
  vi.stubEnv('RELAY_WORKSPACE_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(overrides: Partial<InitCommandDependencies> = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  let serverUp = false;
  const createWorkspace = vi.fn(async (name: string, baseUrl?: string) => ({
    workspaceKey: `rk_live_${name}_${baseUrl?.includes('127.0.0.1') ? 'local' : 'remote'}`,
  }));
  const deps: Partial<InitCommandDependencies> = {
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => errors.push(args.join(' ')),
    exit: vi.fn((code: number) => {
      throw new ExitSignal(code);
    }) as unknown as InitCommandDependencies['exit'],
    createWorkspace: createWorkspace as never,
    startEngine: vi.fn(() => {
      serverUp = true;
      return 4242;
    }),
    isAlive: vi.fn(() => serverUp),
    stop: vi.fn(() => {
      serverUp = false;
    }),
    sleep: async () => undefined,
    fetch: vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/health') return serverUp ? jsonResponse(200, { ok: true }) : jsonResponse(503);
      if (url.pathname === '/v1/workspace') return jsonResponse(200, { ok: true, data: {} });
      return jsonResponse(404);
    }) as never,
    ...overrides,
  };
  const program = new Command().exitOverride();
  registerInitCommand(program, deps);
  const run = (...args: string[]) => program.parseAsync(['init', ...args], { from: 'user' });
  return { run, logs, errors, createWorkspace, deps };
}

describe('relay init', () => {
  it('starts a local server, creates a workspace bound to it, and reuses both on re-run', async () => {
    const { run, logs, createWorkspace, deps } = setup();
    await run();
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledWith('local', 'http://127.0.0.1:8787');
    const key = readWorkspaceStore().workspaces.local?.key;
    expect(key).toBeDefined();
    expect(boundOrigin(key as string)).toBe('http://127.0.0.1:8787');
    expect(logs.join('\n')).toContain('No account needed');

    await run();
    expect(deps.startEngine).toHaveBeenCalledTimes(1);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  it('explains a local server that will not start, with the log tail', async () => {
    const { run, errors } = setup({ startEngine: vi.fn(() => 1), isAlive: vi.fn(() => false) });
    await expect(run()).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toMatch(/did not start.*Node\.js 22 or 24/s);
  });

  it('connects to your own server only after checking the key, and binds the key to it', async () => {
    const { run, logs, createWorkspace } = setup();
    await run('--url', 'https://relay.corp.test:8443', '--key', 'rk_live_corp', '--name', 'corp');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(readWorkspaceStore().workspaces.corp?.key).toBe('rk_live_corp');
    expect(boundOrigin('rk_live_corp')).toBe('https://relay.corp.test:8443');
    expect(logs.join('\n')).toContain('only ever sent to this server');
  });

  it('refuses a self-hosted key the server rejects, and saves nothing', async () => {
    const { run, errors } = setup({ fetch: vi.fn(async () => jsonResponse(401)) as never });
    await expect(run('--url', 'https://relay.corp.test', '--key', 'rk_live_bad')).rejects.toEqual(
      new ExitSignal(1)
    );
    expect(errors.join('\n')).toContain('rejected the workspace key');
    expect(readWorkspaceStore().workspaces['relay.corp.test']).toBeUndefined();
    expect(boundOrigin('rk_live_bad')).toBeUndefined();
  });

  it('requires --url and --key together', async () => {
    const { run, errors } = setup();
    await expect(run('--url', 'https://relay.corp.test')).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('--url and --key together');
  });

  it('creates a hosted workspace and prints the one command another machine runs to join', async () => {
    const { run, logs, createWorkspace } = setup();
    await run('--hosted', '--name', 'team');
    expect(createWorkspace).toHaveBeenCalledWith('team', 'https://cast.agentrelay.com');
    expect(logs.join('\n')).toContain('relay workspace join team rk_live_team_remote');
    expect(boundOrigin('rk_live_team_remote')).toBeUndefined();
  });

  it('keeps the saved local workspace when checking it fails for a reason other than a rejected key', async () => {
    const first = setup();
    await first.run();
    const key = readWorkspaceStore().workspaces.local?.key;

    const { run, errors, createWorkspace } = setup({
      startEngine: vi.fn(() => 4242),
      isAlive: vi.fn(() => true),
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/health') return jsonResponse(200, { ok: true });
        return jsonResponse(503);
      }) as never,
    });
    await expect(run()).rejects.toEqual(new ExitSignal(1));
    expect(errors.join('\n')).toContain('answered 503');
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(readWorkspaceStore().workspaces.local?.key).toBe(key);
  });

  it('replaces the saved local workspace only when the server rejects its key', async () => {
    const first = setup();
    await first.run();

    const createWorkspace = vi.fn(async () => ({ workspaceKey: 'rk_live_local_replacement' }));
    const { run } = setup({
      startEngine: vi.fn(() => 4242),
      isAlive: vi.fn(() => true),
      createWorkspace: createWorkspace as never,
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/health') return jsonResponse(200, { ok: true });
        return jsonResponse(401);
      }) as never,
    });
    await run();
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(readWorkspaceStore().workspaces.local?.key).toBe('rk_live_local_replacement');
    expect(boundOrigin('rk_live_local_replacement')).toBe('http://127.0.0.1:8787');
  });

  it('does not create a workspace whose key it could not bind', async () => {
    fs.writeFileSync(path.join(home, 'relaycast-origins.json'), '{not json');
    const { run, errors, createWorkspace } = setup();
    await expect(run()).rejects.toEqual(new ExitSignal(1));
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('not a valid Relaycast origin file');
  });

  it.each([0, 1, -5, 1.5, '42'])('never signals a process for a saved pid of %s', async (pid) => {
    fs.mkdirSync(path.join(home, 'local'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'local', 'server.json'),
      JSON.stringify({ pid, port: 8787, origin: 'http://127.0.0.1:8787', engine: 'x' })
    );
    const { run, logs, deps } = setup({ isAlive: vi.fn(() => true) });
    await run('--stop');
    expect(deps.stop).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('No local Relay server is running');
  });

  it('stops the local server it started', async () => {
    const { run, logs, deps } = setup();
    await run();
    await run('--stop');
    expect(deps.stop).toHaveBeenCalledWith(4242);
    expect(logs.join('\n')).toContain('Stopped the local Relay server');
  });
});
