import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  expiryFromDays,
  parseScope,
  registerDelegatesCommands,
  type DelegatesDependencies,
} from './delegates.js';

vi.mock('@agent-relay/cloud', () => ({
  defaultApiUrl: () => 'https://cloud.test',
  ensureCloudSession: vi.fn(),
  authorizedApiFetch: vi.fn(),
}));

const auth = {
  apiUrl: 'https://cloud.test',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
};

function harness(answer: unknown = { ok: true }, status = 200) {
  const deps: DelegatesDependencies = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as unknown as DelegatesDependencies['exit'],
    ensureCloudSession: vi.fn(async () => ({
      auth,
      client: {} as never,
    })) as DelegatesDependencies['ensureCloudSession'],
    authorizedApiFetch: vi.fn(async () => ({
      response: new Response(JSON.stringify(answer), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
      auth,
    })) as DelegatesDependencies['authorizedApiFetch'],
  };
  const program = new Command();
  program.exitOverride();
  registerDelegatesCommands(program, deps);
  const run = (...args: string[]) => program.parseAsync(['node', 'agent-relay', 'delegates', ...args]);
  const calls = () =>
    (deps.authorizedApiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, path, init]: [unknown, string, RequestInit]) => ({
        path,
        method: init.method,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      })
    );
  return { deps, run, calls };
}

const WS = 'rw_abcd1234';

describe('agent-relay delegates', () => {
  it('lists grants, the whole workspace with --all', async () => {
    const h = harness({ grants: [] });
    await h.run('list', '--workspace', WS);
    await h.run('list', '--workspace', WS, '--all');
    expect(h.calls()).toEqual([
      { path: `/api/v1/workspaces/${WS}/delegates`, method: 'GET', body: undefined },
      { path: `/api/v1/workspaces/${WS}/delegates?all=1`, method: 'GET', body: undefined },
    ]);
    expect(h.deps.log).toHaveBeenCalledWith(JSON.stringify({ grants: [] }, null, 2));
  });

  it('adds a grant with scopes, expiry and tier O classes', async () => {
    const h = harness({ grant_id: 'grt_1' });
    await h.run(
      'add',
      'agent_assistant',
      '--workspace',
      WS,
      '--scope',
      'merge=AgentWorkforce/*',
      '--scope',
      'prompt_approval=*',
      '--expires-in-days',
      '7',
      '--require-tier-o',
      'merge'
    );
    const [call] = h.calls();
    expect(call.path).toBe(`/api/v1/workspaces/${WS}/delegates`);
    expect(call.method).toBe('POST');
    expect(call.body).toMatchObject({
      delegate_agent_id: 'agent_assistant',
      scopes: [
        { class: 'merge', targets: ['AgentWorkforce/*'] },
        { class: 'prompt_approval', targets: ['*'] },
      ],
      require_tier_o: ['merge'],
    });
    expect(Date.parse(call.body.expires_at)).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
  });

  it('revokes one grant, all of them, and starts a claim', async () => {
    const h = harness();
    await h.run('revoke', 'grt_1', '--workspace', WS);
    await h.run('revoke-all', '--workspace', WS);
    await h.run('revoke-all', '--workspace', WS, '--all');
    await h.run('claim', '--workspace', WS);
    expect(h.calls()).toEqual([
      { path: `/api/v1/workspaces/${WS}/delegates/grt_1`, method: 'DELETE', body: undefined },
      { path: `/api/v1/workspaces/${WS}/delegates/revoke-all`, method: 'POST', body: {} },
      { path: `/api/v1/workspaces/${WS}/delegates/revoke-all`, method: 'POST', body: { all: true } },
      { path: `/api/v1/workspaces/${WS}/delegates/claims`, method: 'POST', body: {} },
    ]);
  });

  it("reports Cloud's refusal and exits 1", async () => {
    const h = harness({ error: 'not_enabled', message: 'Delegation is off for this workspace.' }, 403);
    await expect(h.run('claim', '--workspace', WS)).rejects.toThrow('exit:1');
    expect(h.deps.error).toHaveBeenCalledWith(
      'Agent Relay Cloud refused the request (403 not_enabled): Delegation is off for this workspace.'
    );
  });

  it('checks scopes, expiry and the workspace before asking Cloud', async () => {
    expect(() => parseScope('approve_all=*')).toThrow();
    expect(() => parseScope('merge=')).toThrow();
    expect(parseScope('deploy=api:staging,web:staging')).toEqual([
      { class: 'deploy', targets: ['api:staging', 'web:staging'] },
    ]);
    expect(() => expiryFromDays('91')).toThrow();
    expect(expiryFromDays('1', 0)).toBe(new Date(24 * 3600 * 1000).toISOString());
    const h = harness();
    await expect(h.run('list', '--workspace', 'not a workspace')).rejects.toThrow('exit:1');
    expect(h.calls()).toEqual([]);
  });
});
