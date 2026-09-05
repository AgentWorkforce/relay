import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerCloudWorkspaceCommands } from './cloud-workspace.js';
import type { CloudDependencies } from './cloud.js';

vi.mock('@agent-relay/cloud', () => ({
  defaultApiUrl: () => 'https://cloud.test',
}));

type Deps = Pick<CloudDependencies, 'log' | 'error' | 'exit' | 'ensureCloudSession' | 'authorizedApiFetch'>;

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000801';
const RELAY_WORKSPACE_ID = 'rw_1234abcd';
const EXPIRES_AT = '2026-09-06T00:00:00.000Z';
const RELAYFILE_CLOUD_DEPLOYMENT_ID = 'rfcloud-candidate-71';
const auth = {
  apiUrl: 'https://cloud.test',
  accessToken: 'operator-access-secret',
  refreshToken: 'operator-refresh-secret',
  accessTokenExpiresAt: '2026-09-06T00:00:00.000Z',
};

const revealOnceResponse = {
  workspaceId: WORKSPACE_ID,
  relayWorkspaceId: RELAY_WORKSPACE_ID,
  expiresAt: EXPIRES_AT,
  state: 'active',
  credential: {
    version: 1,
    workspaceId: WORKSPACE_ID,
    relayWorkspaceId: RELAY_WORKSPACE_ID,
    expiresAt: EXPIRES_AT,
    cloud: {
      accessToken: 'ephemeral-access-secret',
      refreshToken: 'ephemeral-refresh-secret',
      accessTokenExpiresAt: EXPIRES_AT,
      refreshTokenExpiresAt: EXPIRES_AT,
    },
    relay: {
      baseUrl: 'https://cast.example.test',
      workspaceKey: 'workspace-key-secret',
    },
  },
};

const cascadeResponse = {
  workspaceId: WORKSPACE_ID,
  relayWorkspaceId: RELAY_WORKSPACE_ID,
  expiresAt: EXPIRES_AT,
  state: 'deleted',
  deleted: true,
  idempotent: false,
  operationId: 'delete-operation-801',
  verifiedAt: '2026-09-05T12:00:30.000Z',
  proof: {
    credentials: {
      workspaceId: WORKSPACE_ID,
      relayWorkspaceId: RELAY_WORKSPACE_ID,
      activeSessionsRemaining: 0,
    },
    cloud: {
      workspaceId: WORKSPACE_ID,
      relayWorkspaceId: RELAY_WORKSPACE_ID,
      appWorkspaceRowsRemaining: 0,
    },
    daytona: { workspaceId: WORKSPACE_ID, relayWorkspaceId: RELAY_WORKSPACE_ID, remaining: 0 },
    relaycast: {
      workspaceId: WORKSPACE_ID,
      relayWorkspaceId: RELAY_WORKSPACE_ID,
      deleted: true,
      agentsAndNodesDeletedByWorkspaceCascade: true,
    },
    relayfile: { workspaceId: WORKSPACE_ID, relayWorkspaceId: RELAY_WORKSPACE_ID, deleted: true },
    registry: { workspaceId: WORKSPACE_ID, relayWorkspaceId: RELAY_WORKSPACE_ID, deleted: true },
  },
};

const tempDirs: string[] = [];

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
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
      response: response(revealOnceResponse, 201),
      auth,
    })) as Deps['authorizedApiFetch'],
  };
  const program = new Command();
  program.exitOverride();
  const cloud = program.command('cloud');
  registerCloudWorkspaceCommands(cloud, deps);
  return { program, deps, workspace: cloud.commands[0] };
}

function tempCredentialPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ephemeral-workspace-'));
  tempDirs.push(directory);
  return path.join(directory, 'credential.json');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('cloud workspace lifecycle commands', () => {
  it('registers only explicit create and delete lifecycle operations', () => {
    const { workspace } = harness();
    expect(workspace.name()).toBe('workspace');
    expect(workspace.commands.map((command) => command.name())).toEqual(['create', 'delete']);
  });

  it('writes the reveal-once credential to a new 0600 file and prints only safe JSON', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'workspace',
      'create',
      '--ephemeral',
      '--name',
      'Fleet qualification',
      '--ttl',
      '24h',
      '--credential-file',
      credentialFile,
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces',
      {
        method: 'POST',
        body: JSON.stringify({
          ephemeral: true,
          name: 'Fleet qualification',
          ttlSeconds: 86_400,
        }),
      },
      { interactive: false }
    );
    expect(fs.statSync(credentialFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(credentialFile, 'utf8'))).toEqual({
      ...revealOnceResponse.credential,
      cloud: {
        apiUrl: 'https://cloud.test',
        ...revealOnceResponse.credential.cloud,
      },
    });

    const stdout = vi.mocked(deps.log).mock.calls.flat().join('\n');
    const stderr = vi.mocked(deps.error).mock.calls.flat().join('\n');
    expect(stdout).toContain(WORKSPACE_ID);
    expect(stdout).toContain(path.resolve(credentialFile));
    expect(`${stdout}\n${stderr}`).not.toMatch(
      /operator-access-secret|operator-refresh-secret|ephemeral-access-secret|ephemeral-refresh-secret|workspace-key-secret/u
    );
  });

  it('refuses an existing credential file before authenticating or creating a workspace', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    fs.writeFileSync(credentialFile, 'keep-me', { mode: 0o600 });

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'create',
        '--ephemeral',
        '--name',
        'No overwrite',
        '--ttl',
        '1h',
        '--credential-file',
        credentialFile,
      ])
    ).rejects.toThrow('exit:1');
    expect(fs.readFileSync(credentialFile, 'utf8')).toBe('keep-me');
    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
    expect(deps.authorizedApiFetch).not.toHaveBeenCalled();
  });

  it('fails before authentication, file reservation, or POST when candidate binding is unsupported', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'create',
        '--ephemeral',
        '--name',
        'Candidate-bound run',
        '--ttl',
        '1h',
        '--credential-file',
        credentialFile,
        '--relayfile-cloud-deployment',
        RELAYFILE_CLOUD_DEPLOYMENT_ID,
      ])
    ).rejects.toThrow('exit:1');
    expect(fs.existsSync(credentialFile)).toBe(false);
    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
    expect(deps.authorizedApiFetch).not.toHaveBeenCalled();
    expect(vi.mocked(deps.log)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.error)).toHaveBeenCalledWith(
      'Relayfile Cloud candidate binding is not supported by the deployed Cloud API.'
    );
  });

  it('removes the reserved file and never prints secrets from an invalid server response', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({ credential: { workspaceKey: 'server-leak-secret' } }, 201),
      auth,
    });

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'create',
        '--ephemeral',
        '--name',
        'Invalid response',
        '--ttl',
        '1h',
        '--credential-file',
        credentialFile,
      ])
    ).rejects.toThrow('exit:1');
    expect(fs.existsSync(credentialFile)).toBe(false);
    expect(vi.mocked(deps.error).mock.calls.flat().join('\n')).not.toContain('server-leak-secret');
  });

  it('rejects an insecure Relay credential endpoint', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response(
        {
          ...revealOnceResponse,
          credential: {
            ...revealOnceResponse.credential,
            relay: { ...revealOnceResponse.credential.relay, baseUrl: 'http://relay.example.test' },
          },
        },
        201
      ),
      auth,
    });

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'create',
        '--ephemeral',
        '--name',
        'Insecure response',
        '--ttl',
        '1h',
        '--credential-file',
        credentialFile,
      ])
    ).rejects.toThrow('exit:1');
    expect(fs.existsSync(credentialFile)).toBe(false);
    expect(vi.mocked(deps.error)).toHaveBeenCalledWith(
      'Cloud returned an invalid ephemeral workspace response.'
    );
  });

  it('sends exact delete confirmation and prints complete cascade proof as JSON', async () => {
    const { program, deps } = harness();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response(cascadeResponse),
      auth,
    });
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({ error: 'not found' }, 404),
      auth,
    });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'workspace',
      'delete',
      WORKSPACE_ID,
      '--confirm',
      WORKSPACE_ID,
      '--verify-cascade',
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      `/api/v1/workspaces/${WORKSPACE_ID}`,
      {
        method: 'DELETE',
        body: JSON.stringify({ confirm: WORKSPACE_ID, verifyCascade: true }),
      },
      { interactive: false }
    );
    expect(deps.authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      auth,
      `/api/v1/workspaces/${WORKSPACE_ID}`,
      { method: 'GET' },
      { interactive: false }
    );
    const result = JSON.parse(String(vi.mocked(deps.log).mock.calls[0]?.[0]));
    expect(result).toMatchObject({
      ...cascadeResponse,
      absence: { workspaceId: WORKSPACE_ID, status: 404 },
    });
    expect(Date.parse(result.absence.verifiedAt)).not.toBeNaN();
  });

  it('rejects missing proof identities and a workspace that remains readable after delete', async () => {
    const missingIdentity = harness();
    vi.mocked(missingIdentity.deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({
        ...cascadeResponse,
        proof: {
          ...cascadeResponse.proof,
          daytona: { remaining: 0 },
        },
      }),
      auth,
    });
    await expect(
      missingIdentity.program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'delete',
        WORKSPACE_ID,
        '--confirm',
        WORKSPACE_ID,
        '--verify-cascade',
      ])
    ).rejects.toThrow('exit:1');

    const stillPresent = harness();
    vi.mocked(stillPresent.deps.authorizedApiFetch)
      .mockResolvedValueOnce({ response: response(cascadeResponse), auth })
      .mockResolvedValueOnce({ response: response({ workspaceId: WORKSPACE_ID }), auth });
    await expect(
      stillPresent.program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'delete',
        WORKSPACE_ID,
        '--confirm',
        WORKSPACE_ID,
        '--verify-cascade',
      ])
    ).rejects.toThrow('exit:1');
    expect(vi.mocked(stillPresent.deps.error).mock.calls.flat().join('\n')).toContain(
      'deleted app workspace is absent'
    );
  });

  it('rejects mismatched confirmation before auth and incomplete server proof after auth', async () => {
    const first = harness();
    await expect(
      first.program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'delete',
        WORKSPACE_ID,
        '--confirm',
        '00000000-0000-4000-8000-000000000899',
        '--verify-cascade',
      ])
    ).rejects.toThrow('exit:1');
    expect(first.deps.ensureCloudSession).not.toHaveBeenCalled();

    const second = harness();
    vi.mocked(second.deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({
        ...cascadeResponse,
        proof: { ...cascadeResponse.proof, daytona: { deleted: 2, remaining: 1 } },
      }),
      auth,
    });
    await expect(
      second.program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'delete',
        WORKSPACE_ID,
        '--confirm',
        WORKSPACE_ID,
        '--verify-cascade',
      ])
    ).rejects.toThrow('exit:1');
    expect(vi.mocked(second.deps.log)).not.toHaveBeenCalled();
    expect(vi.mocked(second.deps.error).mock.calls.flat().join('\n')).toContain(
      'complete cascade reconciliation proof'
    );
  });
});
