import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function credential() {
  return {
    leaseId: 'lease_1',
    relayfileUrl: 'https://relayfile.test',
    relayauthUrl: 'https://relayauth.test',
    refreshUrl: 'https://relayauth.test/v1/tokens/refresh',
    relayfileWorkspaceId: 'rw_7ccfea89',
    relayfileToken: 'relay_pa_private',
    relayfileTokenExpiresAt: '2026-07-23T22:00:00.000Z',
    relayfileRefreshToken: 'relay_pr_private',
    relayfileRefreshTokenExpiresAt: '2026-07-24T21:00:00.000Z',
    relayfileScopes: ['relayfile:fs:read:*', 'relayfile:fs:write:*'],
    delegationNotAfter: '2026-07-24T21:00:00.000Z',
    relayfileMountPaths: ['/linear/**'],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerCloudIntegrationCommands', () => {
  it('registers the complete Cloud integration lifecycle', () => {
    const { integration } = harness();
    expect(integration.commands.map((command) => command.name())).toEqual([
      'catalog',
      'connections',
      'connect',
      'disconnect',
      'grants',
      'grant',
      'revoke-grant',
      'credential',
      'revoke-credential',
    ]);
  });

  it('discovers dynamic providers with truthful capabilities', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({
        providers: [
          {
            id: 'dropbox',
            vfsRoot: '/dropbox',
            capabilities: { connect: true, read: true, writeback: false },
          },
        ],
        version: 'abcdef123456',
      }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'catalog',
      '--workspace',
      'rw_7ccfea89',
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/integrations/catalog?dynamic=true',
      { method: 'GET' },
      { interactive: false }
    );
    expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).toContain('"writeback": false');
  });

  it('creates a bounded write grant for a room member', async () => {
    const { program, deps } = harness();
    const grant = {
      id: 'grant_1',
      workspaceId: '00000000-0000-4000-8000-000000000020',
      memberId: 'member_1',
      userId: '00000000-0000-4000-8000-000000000001',
      provider: 'linear',
      allowedPaths: ['/linear/issues/**'],
      canRead: true,
      canWrite: true,
      createdAt: '2026-07-23T21:00:00.000Z',
      updatedAt: '2026-07-23T21:00:00.000Z',
    };
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({ grant }, 201),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'grant',
      '--workspace',
      'rw_7ccfea89',
      '--member',
      'member_1',
      '--provider',
      'linear',
      '--path',
      '/linear/issues/**',
      '--access',
      'write',
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/room/integration-grants',
      {
        method: 'POST',
        body: JSON.stringify({
          memberId: 'member_1',
          provider: 'linear',
          allowedPaths: ['/linear/issues/**'],
          canRead: true,
          canWrite: true,
        }),
      },
      { interactive: false }
    );
  });

  it('requires an explicit delegated-credential sink before authentication', async () => {
    const { program, deps } = harness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'integration',
        'credential',
        '--workspace',
        'rw_7ccfea89',
        '--device-id',
        'herdr-room-device',
        '--access',
        'write',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith('Use exactly one credential sink: --output-file or --json.');
  });

  it('mints a grant-intersected write credential without caller identity fields', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response(credential()),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'credential',
      '--workspace',
      'rw_7ccfea89',
      '--device-id',
      'herdr-room-device',
      '--access',
      'write',
      '--path',
      '/linear/**',
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/relayfile/delegated-token',
      {
        method: 'POST',
        body: JSON.stringify({
          deviceId: 'herdr-room-device',
          scopes: ['fs:read', 'fs:write'],
          relayfileMountPaths: ['/linear/**'],
          ttlSeconds: 3600,
          delegationTtlSeconds: 86400,
        }),
      },
      { interactive: false }
    );
    expect(vi.mocked(deps.log).mock.calls.flat().join('\n')).toContain('relay_pa_private');
  });

  it('writes a delegated credential only to a new owner-only file', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-integration-credential-'));
    const target = path.join(directory, 'credential.json');
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response(credential()),
      auth,
    });
    try {
      await program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'integration',
        'credential',
        '--workspace',
        'rw_7ccfea89',
        '--device-id',
        'herdr-room-device',
        '--access',
        'read',
        '--output-file',
        target,
      ]);
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({
        leaseId: 'lease_1',
        relayfileToken: 'relay_pa_private',
      });
      if (process.platform !== 'win32') {
        expect(fs.statSync(target).mode & 0o077).toBe(0);
      }
      const requestBody = JSON.parse(
        String(vi.mocked(deps.authorizedApiFetch).mock.calls[0]?.[2]?.body)
      ) as Record<string, unknown>;
      expect(requestBody).not.toHaveProperty('relayfileMountPaths');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('revokes a newly minted lease when the output file cannot be created', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-integration-credential-'));
    const target = path.join(directory, 'existing');
    fs.writeFileSync(target, 'preserve', { mode: 0o600 });
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch)
      .mockResolvedValueOnce({ response: response(credential()), auth })
      .mockResolvedValueOnce({ response: new Response(null, { status: 204 }), auth });
    try {
      await expect(
        program.parseAsync([
          'node',
          'agent-relay',
          'cloud',
          'integration',
          'credential',
          '--workspace',
          'rw_7ccfea89',
          '--device-id',
          'herdr-room-device',
          '--access',
          'write',
          '--output-file',
          target,
        ])
      ).rejects.toThrow('exit:1');
      expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    expect(deps.authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      auth,
      '/api/v1/workspaces/rw_7ccfea89/relayfile/delegated-token/lease_1',
      { method: 'DELETE' },
      { interactive: false }
    );
  });

  it('revokes a device-scoped credential lease without putting secrets in argv', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: new Response(null, { status: 204 }),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'integration',
      'revoke-credential',
      'lease_1',
      '--workspace',
      'rw_7ccfea89',
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces/rw_7ccfea89/relayfile/delegated-token/lease_1',
      { method: 'DELETE' },
      { interactive: false }
    );
  });

  it('strips server credential fields from a connection session response', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({
        connectLink: 'https://connect.test/session',
        workspaceId: 'app_workspace',
        relayWorkspaceId: 'rw_7ccfea89',
        backend: 'nango',
        providers: [
          {
            id: 'linear',
            displayName: 'Linear',
            backendMetadata: { sessionToken: 'nested-must-not-print' },
          },
        ],
        token: 'must-not-print',
        sessionToken: 'must-not-print',
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
      '--json',
    ]);

    const output = vi.mocked(deps.log).mock.calls.flat().join('\n');
    expect(output).toContain('https://connect.test/session');
    expect(output).toContain('"linear"');
    expect(output).not.toContain('must-not-print');
  });

  it('fails closed before forwarding Cloud auth to a mismatched API host', async () => {
    const { program, deps } = harness();

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'integration',
        'catalog',
        '--workspace',
        'rw_7ccfea89',
        '--api-url',
        'http://127.0.0.1:4310',
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).not.toHaveBeenCalled();
  });
});
