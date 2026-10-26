import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isAgentAlreadyExists, takeOverAgent } from './agent-takeover.js';
import { agentTokensPath, saveAgentToken, savedAgentToken } from './agent-token-store.js';
import { boundOrigin } from './relaycast-origin-binding.js';
import { createAgentRelay, resolveAgentToken } from './sdk-client.js';

let home: string;
let project: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { AGENT_RELAY_HOME: home, AGENT_RELAY_PROJECT: project, ...extra };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tokens-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-tokens-project-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('saved agent tokens', () => {
  it('saves by name per workspace and server, privately', () => {
    saveAgentToken('rk_live_a', 'http://127.0.0.1:8787', 'alice', 'at_live_1', env());
    expect(savedAgentToken('rk_live_a', 'http://127.0.0.1:8787', 'alice', env())).toBe('at_live_1');
    expect(savedAgentToken('rk_live_b', 'http://127.0.0.1:8787', 'alice', env())).toBeUndefined();
    expect(savedAgentToken('rk_live_a', undefined, 'alice', env())).toBeUndefined();
    expect(fs.readFileSync(agentTokensPath(env()), 'utf8')).not.toContain('rk_live_a');
    if (process.platform !== 'win32') expect(fs.statSync(agentTokensPath(env())).mode & 0o777).toBe(0o600);
  });

  it('--as resolves the saved token for the selected workspace', () => {
    saveAgentToken('rk_live_a', 'https://relay.corp.test', 'alice', 'at_live_alice', env());
    expect(
      resolveAgentToken({
        asAgent: 'alice',
        workspaceKey: 'rk_live_a',
        env: env({ RELAY_BASE_URL: 'https://relay.corp.test' }),
      })
    ).toBe('at_live_alice');
  });

  it('--as names the fix when nothing is saved', () => {
    expect(() => resolveAgentToken({ asAgent: 'ghost', workspaceKey: 'rk_live_a', env: env() })).toThrow(
      /agent register ghost/
    );
  });

  it('--as sends the saved token to the server of its workspace, not the hosted default', () => {
    saveAgentToken('rk_live_a', 'http://127.0.0.1:8787', 'alice', 'at_live_alice', env());
    // The workspace key is bound to the local server, as `relay init` does.
    createAgentRelay({ workspaceKey: 'rk_live_a', env: env({ RELAY_BASE_URL: 'http://127.0.0.1:8787' }) });
    const relay = createAgentRelay({
      asAgent: 'alice',
      workspaceKey: 'rk_live_a',
      env: env(),
    }) as unknown as {
      baseUrl?: string;
    };
    expect(relay).toBeDefined();
    expect(boundOrigin('at_live_alice', env())).toBe('http://127.0.0.1:8787');
  });
});

describe('saved agent token file', () => {
  it('fails closed on a malformed file instead of forgetting tokens', () => {
    fs.mkdirSync(home, { recursive: true });
    for (const contents of [
      { version: 1, tokens: ['at_live_x'] },
      { version: 1, tokens: { k: null } },
      [{ version: 1, tokens: {} }],
    ]) {
      fs.writeFileSync(agentTokensPath(env()), JSON.stringify(contents));
      expect(() => savedAgentToken('rk', undefined, 'alice', env())).toThrow(/not a valid agent token file/);
    }
  });

  it('does not drop a token another process saves while this one waits for the lock', async () => {
    const file = agentTokensPath(env());
    const other = spawn(
      process.execPath,
      [
        '-e',
        `const fs = require('node:fs');
         const path = require('node:path');
         const file = process.argv[1];
         fs.mkdirSync(file + '.lock');
         fs.writeFileSync(path.join(file + '.lock', 'owner'), String(process.pid));
         console.log('locked');
         setTimeout(() => {
           fs.writeFileSync(file, JSON.stringify({ version: 1, tokens: { other: 'at_live_other' } }));
           fs.rmSync(file + '.lock', { recursive: true, force: true });
         }, 300);`,
        file,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise<void>((resolve) => other.stdout.once('data', () => resolve()));
    saveAgentToken('rk_live_a', undefined, 'alice', 'at_live_alice', env());
    await new Promise((resolve) => other.once('exit', resolve));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { tokens: Record<string, string> };
    expect(saved.tokens.other).toBe('at_live_other');
    expect(savedAgentToken('rk_live_a', undefined, 'alice', env())).toBe('at_live_alice');
  });
});

describe('owner takeover', () => {
  function takeoverServer(failOnTakeover?: number) {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    let takeovers = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      });
      if (url.endsWith('/takeover')) {
        takeovers += 1;
        if (takeovers === failOnTakeover) throw new TypeError('fetch failed');
        const data = { agent_id: 'agent-1', name: 'alice', token: `at_live_new_${takeovers}` };
        return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, data: { id: 'agent-1', name: 'alice' } }), {
        status: 200,
      });
    });
    const paths = () => calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
    return { calls, fetchFn, paths };
  }

  it('takes over twice, so the old token is retired at once and never revoked first', async () => {
    const { calls, fetchFn, paths } = takeoverServer();
    const grant = await takeOverAgent(
      { workspaceKey: 'rk_live_a', baseUrl: 'http://127.0.0.1:8787', fetch: fetchFn as never },
      'alice',
      'test'
    );
    expect(grant).toEqual({ id: 'agent-1', name: 'alice', token: 'at_live_new_2' });
    expect(paths()).toEqual([
      'GET /v1/agents/alice',
      'POST /v1/agents/alice/takeover',
      'POST /v1/agents/alice/takeover',
    ]);
    expect(calls[1]?.body).toMatchObject({ expected_agent_id: 'agent-1', reason: 'test' });
    expect(calls[2]?.body).toMatchObject({ expected_agent_id: 'agent-1' });
  });

  it('keeps the agent working when the first takeover fails: nothing was changed', async () => {
    const { fetchFn, paths } = takeoverServer(1);
    await expect(
      takeOverAgent(
        { workspaceKey: 'rk', baseUrl: 'http://127.0.0.1:1', fetch: fetchFn as never },
        'alice',
        'x'
      )
    ).rejects.toThrow('fetch failed');
    expect(paths()).not.toContain('POST /v1/agents/alice/revoke-token');
  });

  it('returns the first replacement when the second takeover fails', async () => {
    const { fetchFn } = takeoverServer(2);
    const grant = await takeOverAgent(
      { workspaceKey: 'rk', baseUrl: 'http://127.0.0.1:1', fetch: fetchFn as never },
      'alice',
      'x'
    );
    expect(grant).toEqual({
      id: 'agent-1',
      name: 'alice',
      token: 'at_live_new_1',
      oldTokenGraceRemains: true,
    });
  });

  it('still takes over when the local user has no passwd entry', async () => {
    vi.spyOn(os, 'userInfo').mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory, uv_os_get_passwd');
    });
    const { calls, fetchFn } = takeoverServer();
    await takeOverAgent(
      { workspaceKey: 'rk', baseUrl: 'http://127.0.0.1:1', fetch: fetchFn as never },
      'alice',
      'x'
    );
    expect(String(calls[1]?.body?.actor)).toMatch(/^agent-relay-cli:.+@/);
  });

  it('reports a missing agent with its status so callers can say so', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: 'agent_not_found', message: 'nope' } }), {
          status: 404,
        })
    );
    await expect(
      takeOverAgent(
        { workspaceKey: 'rk', baseUrl: 'http://127.0.0.1:1', fetch: fetchFn as never },
        'ghost',
        'x'
      )
    ).rejects.toMatchObject({ status: 404, code: 'agent_not_found' });
  });

  it('recognises an already-taken name', () => {
    expect(isAgentAlreadyExists({ code: 'agent_already_exists' })).toBe(true);
    expect(isAgentAlreadyExists(new Error('Agent "a" already exists in this workspace'))).toBe(true);
    expect(isAgentAlreadyExists(new Error('unauthorized'))).toBe(false);
  });
});
