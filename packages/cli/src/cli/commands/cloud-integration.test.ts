import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCloudIntegrationCommands } from './cloud-integration.js';
import type { CloudDependencies } from './cloud.js';

vi.mock('@agent-relay/cloud', () => ({
  defaultApiUrl: () => 'https://cloud.test',
}));

type Deps = Pick<CloudDependencies, 'log' | 'error' | 'exit' | 'ensureCloudSession' | 'authorizedApiFetch'>;

const auth = {
  apiUrl: 'https://cloud.test',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  accessTokenExpiresAt: '2999-01-01T00:00:00.000Z',
};

function response(value: unknown, status = 200): Response {
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: value === null ? undefined : { 'content-type': 'application/json' },
  });
}

function harness() {
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as Deps['exit'];
  const deps: Deps = {
    log: vi.fn(),
    error: vi.fn(),
    exit,
    ensureCloudSession: vi.fn(async () => ({ auth, client: {} as never })) as Deps['ensureCloudSession'],
    authorizedApiFetch: vi.fn(async () => ({
      response: response({}),
      auth,
    })) as Deps['authorizedApiFetch'],
  };
  const program = new Command();
  program.exitOverride();
  const cloud = program.command('cloud');
  registerCloudIntegrationCommands(cloud, deps);
  return { program, deps, integration: cloud.commands[0] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerCloudIntegrationCommands', () => {
  it('exposes only the existing Cloud connection lifecycle', () => {
    const { integration } = harness();
    expect(integration.commands.map((command) => command.name())).toEqual([
      'catalog',
      'connections',
      'connect',
      'disconnect',
    ]);
  });

  it('lists dynamic providers without requiring room-specific capabilities', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({
        providers: [
          {
            id: 'linear',
            displayName: 'Linear',
            backends: ['nango'],
            apiKey: 'must-not-print',
          },
        ],
        version: 'abcdef123456',
      }),
      auth,
    });

    await program.parseAsync(['node', 'agent-relay', 'cloud', 'integration', 'catalog', '--json']);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/integrations/catalog?dynamic=true',
      { method: 'GET' },
      { interactive: false }
    );
    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('"id": "linear"');
    expect(output).not.toContain('must-not-print');
  });

  it('filters the catalog locally by backend and search text', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({
        providers: [
          { id: 'linear', displayName: 'Linear', backends: ['nango'] },
          { id: 'github', displayName: 'GitHub', backends: ['composio'] },
        ],
        version: '1',
      }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'catalog',
      '--search',
      'git',
      '--backend',
      'composio',
      '--json',
    ]);

    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('"id": "github"');
    expect(output).not.toContain('"id": "linear"');
  });

  it('lists workspace connections using the existing endpoint', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response([{ id: 'linear', status: 'connected', token: 'hidden' }]),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'connections',
      '--workspace',
      'rw_7ccfea89',
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/integrations',
      { method: 'GET' },
      { interactive: false }
    );
    expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).not.toContain('hidden');
  });

  it('renders connected providers for humans by default', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response([{ provider: 'linear', status: 'connected' }]),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'connections',
      '--workspace',
      'rw_7ccfea89',
    ]);

    expect(deps.log).toHaveBeenCalledWith('linear  connected');
  });

  it('creates a provider connection session', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({
        connectLink: 'https://cloud.test/connect/opaque',
        workspaceId: '00000000-0000-4000-8000-000000000020',
        relayWorkspaceId: 'rw_7ccfea89',
        backend: 'nango',
        providers: [{ id: 'linear' }],
        expiresAt: '2026-07-30T00:00:00.000Z',
      }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'connect',
      'linear',
      '--workspace',
      'rw_7ccfea89',
      '--backend',
      'nango',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/integrations/connect-session',
      {
        method: 'POST',
        body: JSON.stringify({
          allowedIntegrations: ['linear'],
          requestedBackend: 'nango',
        }),
      },
      { interactive: false }
    );
    expect(deps.log).toHaveBeenCalledWith('https://cloud.test/connect/opaque');
  });

  it('disconnects a provider through the existing status endpoint', async () => {
    const { program, deps } = harness();

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'disconnect',
      'linear',
      '--workspace',
      'rw_7ccfea89',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/integrations/linear/status',
      { method: 'DELETE' },
      { interactive: false }
    );
    expect(deps.log).toHaveBeenCalledWith('Disconnected linear.');
  });

  it('rejects invalid workspace and provider IDs before authenticating', async () => {
    const { program, deps } = harness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'integration',
        'connect',
        '../linear',
        '--workspace',
        'not-a-workspace',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
  });

  it('does not reuse a login bound to a different explicit API host', async () => {
    const { program, deps } = harness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'integration',
        'catalog',
        '--api-url',
        'https://other.test',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining('Cloud login is bound to'));
  });

  it('maps authorization failures to a stable error without reflecting response bodies', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({ error: 'private server detail' }, 403),
      auth,
    });

    await expect(
      program.parseAsync(['node', 'agent-relay', 'cloud', 'integration', 'catalog'])
    ).rejects.toThrow('exit:1');

    expect(deps.error).toHaveBeenCalledWith(
      'You do not have permission to perform that integration operation.'
    );
    expect(vi.mocked(deps.error).mock.calls.flat().join('\n')).not.toContain('private server detail');
  });
});
