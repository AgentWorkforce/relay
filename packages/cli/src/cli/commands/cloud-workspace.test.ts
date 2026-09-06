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
const IDEMPOTENCY_KEY = 'qualification:relay-pr-1665:workspace-801';

function readPrivateJsonFile(file: string): unknown {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const info = fs.fstatSync(descriptor);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
}

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
  requestedRelayfileCloudDeploymentId: RELAYFILE_CLOUD_DEPLOYMENT_ID,
  observedRelayfileCloudDeploymentId: RELAYFILE_CLOUD_DEPLOYMENT_ID,
  relayfileCloudAttestationSha256: 'a'.repeat(64),
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
      workflowLaunchesInProgress: 0,
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

const reconciliationResponse = {
  workspaceId: WORKSPACE_ID,
  relayWorkspaceId: RELAY_WORKSPACE_ID,
  expiresAt: EXPIRES_AT,
  state: 'active',
  requestedRelayfileCloudDeploymentId: RELAYFILE_CLOUD_DEPLOYMENT_ID,
  observedRelayfileCloudDeploymentId: RELAYFILE_CLOUD_DEPLOYMENT_ID,
  relayfileCloudSourceGitSha: 'b'.repeat(40),
  relayfileCloudAttestationSha256: 'a'.repeat(64),
  relayfileCloudEndpointIdentitySha256: 'c'.repeat(64),
  sandboxSnapshotId: 'snapshot-801',
  sandboxSnapshotManifestSha256: 'd'.repeat(64),
  credentialRevealed: true,
  replay: true,
};

const tempDirs: string[] = [];

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-agent-relay-ephemeral-reconciliation': 'v1',
    },
  });
}

const reconciliationAbsent = { error: 'Ephemeral workspace not found', code: 'workspace_not_found' };

function harness() {
  const exit = vi.fn((code: number) => {
    throw new Error(`exit:${code}`);
  }) as unknown as Deps['exit'];
  const deps: Deps = {
    log: vi.fn(),
    error: vi.fn(),
    exit,
    ensureCloudSession: vi.fn(async () => ({ auth, client: {} as never })) as Deps['ensureCloudSession'],
    authorizedApiFetch: vi.fn(async (_auth, apiPath) => ({
      response: apiPath.includes('?ephemeral=true')
        ? response(reconciliationAbsent, 404)
        : response(revealOnceResponse, 201),
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
      '--relayfile-cloud-deployment',
      RELAYFILE_CLOUD_DEPLOYMENT_ID,
      '--idempotency-key',
      IDEMPOTENCY_KEY,
      '--json',
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      '/api/v1/workspaces',
      {
        method: 'POST',
        headers: { 'idempotency-key': IDEMPOTENCY_KEY },
        body: JSON.stringify({
          ephemeral: true,
          name: 'Fleet qualification',
          ttlSeconds: 86_400,
          idempotencyKey: IDEMPOTENCY_KEY,
          relayfileCloudDeploymentId: RELAYFILE_CLOUD_DEPLOYMENT_ID,
        }),
      },
      { interactive: false }
    );
    expect(readPrivateJsonFile(credentialFile)).toEqual({
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
        '--relayfile-cloud-deployment',
        RELAYFILE_CLOUD_DEPLOYMENT_ID,
      ])
    ).rejects.toThrow('exit:1');
    expect(fs.readFileSync(credentialFile, 'utf8')).toBe('keep-me');
    expect(deps.ensureCloudSession).not.toHaveBeenCalled();
    expect(deps.authorizedApiFetch).not.toHaveBeenCalled();
  });

  it('sends the exact candidate deployment and idempotency contract', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch)
      .mockResolvedValueOnce({ response: response(reconciliationAbsent, 404), auth })
      .mockResolvedValueOnce({
        response: response(
          {
            ...revealOnceResponse,
            requestedRelayfileCloudDeploymentId: RELAYFILE_CLOUD_DEPLOYMENT_ID,
            observedRelayfileCloudDeploymentId: RELAYFILE_CLOUD_DEPLOYMENT_ID,
            relayfileCloudAttestationSha256: 'a'.repeat(64),
          },
          201
        ),
        auth,
      });

    await program.parseAsync([
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
      '--idempotency-key',
      IDEMPOTENCY_KEY,
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      auth,
      '/api/v1/workspaces',
      expect.objectContaining({
        headers: { 'idempotency-key': IDEMPOTENCY_KEY },
        body: expect.stringContaining(`\"relayfileCloudDeploymentId\":\"${RELAYFILE_CLOUD_DEPLOYMENT_ID}\"`),
      }),
      { interactive: false }
    );
    expect(fs.existsSync(credentialFile)).toBe(true);
    expect(vi.mocked(deps.error)).not.toHaveBeenCalled();
  });

  it('fails closed before POST when Cloud lacks the candidate reconciliation contract', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response({ workspaces: [] }),
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
        'Unsupported Cloud',
        '--ttl',
        '1h',
        '--credential-file',
        credentialFile,
        '--relayfile-cloud-deployment',
        RELAYFILE_CLOUD_DEPLOYMENT_ID,
        '--idempotency-key',
        IDEMPOTENCY_KEY,
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).toHaveBeenCalledTimes(1);
    expect(deps.authorizedApiFetch).toHaveBeenCalledWith(
      auth,
      `/api/v1/workspaces?ephemeral=true&idempotencyKey=${encodeURIComponent(IDEMPOTENCY_KEY)}`,
      { method: 'GET' },
      { interactive: false }
    );
    expect(fs.existsSync(credentialFile)).toBe(false);
    expect(vi.mocked(deps.error)).toHaveBeenCalledWith(
      'Cloud returned an invalid workspace reconciliation response.'
    );
  });

  it('never deletes a pre-existing workspace discovered by the ownership probe', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response(reconciliationResponse),
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
        'Concurrent owner',
        '--ttl',
        '1h',
        '--credential-file',
        credentialFile,
        '--relayfile-cloud-deployment',
        RELAYFILE_CLOUD_DEPLOYMENT_ID,
        '--idempotency-key',
        IDEMPOTENCY_KEY,
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.error)).toHaveBeenCalledWith(
      'An ephemeral workspace already exists for this idempotency key; refusing to delete a workspace this process did not create.'
    );
    expect(fs.existsSync(credentialFile)).toBe(false);
  });

  it('uses refreshed reconciliation auth for the create and persisted Cloud URL', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    const refreshedAuth = {
      ...auth,
      apiUrl: 'https://refreshed.cloud.test',
      accessToken: 'refreshed-access-secret',
    };
    vi.mocked(deps.authorizedApiFetch)
      .mockResolvedValueOnce({ response: response(reconciliationAbsent, 404), auth: refreshedAuth })
      .mockResolvedValueOnce({ response: response(revealOnceResponse, 201), auth: refreshedAuth });

    await program.parseAsync([
      'node',
      'agent-relay',
      'cloud',
      'workspace',
      'create',
      '--ephemeral',
      '--name',
      'Refreshed auth',
      '--ttl',
      '1h',
      '--credential-file',
      credentialFile,
      '--relayfile-cloud-deployment',
      RELAYFILE_CLOUD_DEPLOYMENT_ID,
      '--idempotency-key',
      IDEMPOTENCY_KEY,
    ]);

    expect(deps.authorizedApiFetch).toHaveBeenNthCalledWith(
      2,
      refreshedAuth,
      '/api/v1/workspaces',
      expect.any(Object),
      { interactive: false }
    );
    expect(readPrivateJsonFile(credentialFile)).toMatchObject({
      cloud: { apiUrl: refreshedAuth.apiUrl },
    });
  });

  it('rejects a bare 404 that does not advertise the reconciliation contract', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: new Response(JSON.stringify(reconciliationAbsent), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
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
        'Unsupported Cloud route',
        '--ttl',
        '1h',
        '--credential-file',
        credentialFile,
        '--relayfile-cloud-deployment',
        RELAYFILE_CLOUD_DEPLOYMENT_ID,
        '--idempotency-key',
        IDEMPOTENCY_KEY,
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.error)).toHaveBeenCalledWith(
      'Cloud does not advertise the ephemeral workspace reconciliation v1 contract.'
    );
  });

  it('removes the reserved file and never prints secrets from an invalid server response', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response(reconciliationAbsent, 404),
      auth,
    });
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
        '--relayfile-cloud-deployment',
        RELAYFILE_CLOUD_DEPLOYMENT_ID,
      ])
    ).rejects.toThrow('exit:1');
    expect(fs.existsSync(credentialFile)).toBe(false);
    expect(vi.mocked(deps.error).mock.calls.flat().join('\n')).not.toContain('server-leak-secret');
  });

  it('reconciles but never deletes an unowned workspace after an ambiguous create failure', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch)
      .mockResolvedValueOnce({ response: response(reconciliationAbsent, 404), auth })
      .mockRejectedValueOnce(new Error('create transport closed'))
      .mockResolvedValueOnce({ response: response(reconciliationResponse), auth });

    await expect(
      program.parseAsync([
        'node',
        'agent-relay',
        'cloud',
        'workspace',
        'create',
        '--ephemeral',
        '--name',
        'Ambiguous create',
        '--ttl',
        '1h',
        '--credential-file',
        credentialFile,
        '--relayfile-cloud-deployment',
        RELAYFILE_CLOUD_DEPLOYMENT_ID,
        '--idempotency-key',
        IDEMPOTENCY_KEY,
      ])
    ).rejects.toThrow('exit:1');

    expect(deps.authorizedApiFetch).toHaveBeenNthCalledWith(
      3,
      auth,
      `/api/v1/workspaces?ephemeral=true&idempotencyKey=${encodeURIComponent(IDEMPOTENCY_KEY)}`,
      { method: 'GET' },
      { interactive: false }
    );
    expect(deps.authorizedApiFetch).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(credentialFile)).toBe(false);
    expect(vi.mocked(deps.error)).toHaveBeenCalledWith(
      expect.stringMatching(
        /create transport closed.*was not deleted because this process cannot prove ownership/
      )
    );
  });

  it('rejects an insecure Relay credential endpoint', async () => {
    const { program, deps } = harness();
    const credentialFile = tempCredentialPath();
    vi.mocked(deps.authorizedApiFetch).mockResolvedValueOnce({
      response: response(reconciliationAbsent, 404),
      auth,
    });
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
        '--relayfile-cloud-deployment',
        RELAYFILE_CLOUD_DEPLOYMENT_ID,
      ])
    ).rejects.toThrow('exit:1');
    expect(fs.existsSync(credentialFile)).toBe(false);
    expect(vi.mocked(deps.error).mock.calls.flat().join('\n')).toContain(
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
      response: response(reconciliationAbsent, 404),
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
