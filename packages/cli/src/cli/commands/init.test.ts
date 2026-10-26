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
    exit: ((code: number) => {
      throw new Error(`exit:${code}`);
    }) as never,
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
    await expect(run()).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toMatch(/did not start.*Node\.js 20, 22 or 24/s);
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
    await expect(run('--url', 'https://relay.corp.test', '--key', 'rk_live_bad')).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('rejected the workspace key');
    expect(readWorkspaceStore().workspaces['relay.corp.test']).toBeUndefined();
    expect(boundOrigin('rk_live_bad')).toBeUndefined();
  });

  it('requires --url and --key together', async () => {
    const { run, errors } = setup();
    await expect(run('--url', 'https://relay.corp.test')).rejects.toThrow('exit:1');
    expect(errors.join('\n')).toContain('--url and --key together');
  });

  it('creates a hosted workspace and prints the one command another machine runs to join', async () => {
    const { run, logs, createWorkspace } = setup();
    await run('--hosted', '--name', 'team');
    expect(createWorkspace).toHaveBeenCalledWith('team', 'https://cast.agentrelay.com');
    expect(logs.join('\n')).toContain('relay workspace join team rk_live_team_remote');
    expect(boundOrigin('rk_live_team_remote')).toBeUndefined();
  });

  it('stops the local server it started', async () => {
    const { run, logs, deps } = setup();
    await run();
    await run('--stop');
    expect(deps.stop).toHaveBeenCalledWith(4242);
    expect(logs.join('\n')).toContain('Stopped the local Relay server');
  });
});
