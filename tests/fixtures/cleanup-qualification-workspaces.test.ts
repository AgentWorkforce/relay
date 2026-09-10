import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWorkspace,
  deleteAndVerify,
  reconcile,
  trustedOutputPath,
} from '../../scripts/verify-features/cleanup-qualification-workspaces.mjs';

const auth = {
  apiUrl: 'https://cloud.example.test',
  accessToken: 'access-token-fixture',
  refreshToken: 'refresh-token-fixture',
  accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
  refreshTokenExpiresAt: '2099-01-02T00:00:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

describe('trusted qualification workspace cleanup', () => {
  it('normalizes an independently observed reconciliation absence', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'workspace_not_found' }), {
        status: 404,
        headers: { 'x-agent-relay-ephemeral-reconciliation': 'v1' },
      })
    );

    const result = await reconcile({
      auth,
      idempotencyKey: 'relay-qualification:run:attempt:a',
      name: 'relay-qualification-run-attempt-a',
      deploymentId: 'relayfile-cloud-preview-1',
    });

    expect(result).toMatchObject({ absent: true, workspaceId: null, absenceStatus: 404 });
    const [reconcileUrl, reconcileInit] = fetchMock.mock.calls[0];
    expect(String(reconcileUrl)).toBe(
      'https://cloud.example.test/api/v1/workspaces?ephemeral=true&idempotencyKey=relay-qualification%3Arun%3Aattempt%3Aa&name=relay-qualification-run-attempt-a'
    );
    expect(new Headers(reconcileInit?.headers).get('authorization')).toBe('Bearer access-token-fixture');
  });

  it('rereads the exact prior UUID before accepting collection absence', async () => {
    const priorId = '11111111-1111-4111-8111-111111111111';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'workspace_not_found' }), {
          status: 404,
          headers: { 'x-agent-relay-ephemeral-reconciliation': 'v1' },
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'workspace_not_found' }), { status: 404 }));
    const result = await reconcile({
      auth,
      idempotencyKey: 'relay-qualification:run:attempt:a',
      name: 'relay-qualification-run-attempt-a',
      deploymentId: 'relayfile-cloud-preview-1',
      expectedWorkspaceId: priorId,
    });
    expect(result).toMatchObject({ exactWorkspaceId: priorId, exactAbsenceStatus: 404 });
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(`/api/v1/workspaces/${priorId}`);
  });

  it('creates through the trusted API and writes only the credential file', async () => {
    const credentialPath = '/tmp/relay-qualification-create-fixture.json';
    const fs = await import('node:fs/promises');
    await fs.rm(credentialPath, { force: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          workspaceId: '11111111-1111-4111-8111-111111111111',
          relayWorkspaceId: 'rw_7ccfea89',
          expiresAt: '2099-01-01T00:00:00.000Z',
          state: 'active',
          requestedRelayfileCloudDeploymentId: 'relayfile-cloud-preview-1',
          observedRelayfileCloudDeploymentId: 'relayfile-cloud-preview-1',
          credential: {
            version: 1,
            workspaceId: '11111111-1111-4111-8111-111111111111',
            relayWorkspaceId: 'rw_7ccfea89',
            expiresAt: '2099-01-01T00:00:00.000Z',
            cloud: { accessToken: 'secret', refreshToken: 'refresh' },
            relay: { baseUrl: 'https://relay.example.test', workspaceKey: 'secret-key' },
          },
        }),
        { status: 200 }
      )
    );
    const result = await createWorkspace({
      auth,
      idempotencyKey: 'relay-qualification:run:attempt:a',
      name: 'relay-qualification-run-attempt-a',
      deploymentId: 'relayfile-cloud-preview-1',
      credentialFile: credentialPath,
    });
    expect(result).toMatchObject({ workspaceId: '11111111-1111-4111-8111-111111111111', state: 'active' });
    await expect(fs.readFile(credentialPath, 'utf8')).resolves.toContain('secret-key');
    await fs.rm(credentialPath, { force: true });
  });

  it('deletes only the exact UUID and independently proves a 404', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workspaceId,
            deleted: true,
            state: 'deleted',
            operationId: 'op-qualification-a',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'workspace_not_found' }), { status: 404 }));

    const result = await deleteAndVerify({ auth, workspaceId });

    expect(result.absence).toMatchObject({ workspaceId, status: 404 });
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[0];
    expect(String(deleteUrl)).toBe(`https://cloud.example.test/api/v1/workspaces/${workspaceId}`);
    expect(deleteInit).toMatchObject({
      method: 'DELETE',
      body: JSON.stringify({ confirm: workspaceId, verifyCascade: true }),
    });
    const [absenceUrl, absenceInit] = fetchMock.mock.calls[1];
    expect(String(absenceUrl)).toBe(`https://cloud.example.test/api/v1/workspaces/${workspaceId}`);
    expect(absenceInit).toMatchObject({ method: 'GET' });
  });

  it('rejects malformed or non-owned workspace identifiers before a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(deleteAndVerify({ auth, workspaceId: 'not-a-uuid' })).rejects.toThrow(
      /workspace id is invalid/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts only the four task-owned cleanup evidence paths', () => {
    for (const name of ['reconcile-a.json', 'reconcile-b.json', 'delete-a.json', 'delete-b.json']) {
      expect(trustedOutputPath(`qualification-cleanup/${name}`)).toMatch(new RegExp(`${name}$`));
    }
  });

  it('rejects traversal, absolute paths outside the evidence root, and unexpected filenames', () => {
    for (const value of [
      'qualification-cleanup/../outside.json',
      '/tmp/qualification-cleanup/reconcile-a.json',
      'qualification-cleanup/reconcile-c.json',
      'qualification-cleanup/reconcile-a.txt',
    ]) {
      expect(() => trustedOutputPath(value)).toThrow(/qualification output/);
    }
  });
});
