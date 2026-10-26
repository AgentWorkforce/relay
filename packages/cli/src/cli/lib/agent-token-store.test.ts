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

describe('owner takeover', () => {
  it('looks up the agent id and issues a new token through the audited takeover', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const data = url.endsWith('/takeover')
        ? { agent_id: 'agent-1', name: 'alice', token: 'at_live_new' }
        : url.endsWith('/revoke-token')
          ? { agent_id: 'agent-1', name: 'alice' }
          : { id: 'agent-1', name: 'alice' };
      return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    });
    const grant = await takeOverAgent(
      { workspaceKey: 'rk_live_a', baseUrl: 'http://127.0.0.1:8787', fetch: fetchFn as never },
      'alice',
      'test'
    );
    expect(grant).toEqual({ id: 'agent-1', name: 'alice', token: 'at_live_new' });
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /v1/agents/alice',
      'POST /v1/agents/alice/revoke-token',
      'POST /v1/agents/alice/takeover',
    ]);
    // Revoke before issuing, so the previous token stops working.
    expect(calls[1]?.body).toMatchObject({ expected_agent_id: 'agent-1', reason: 'test' });
    expect(calls[2]?.body).toMatchObject({ expected_agent_id: 'agent-1', reason: 'test' });
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
