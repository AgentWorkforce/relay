import { afterEach, describe, expect, it, vi } from 'vitest';

import {
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
