import { describe, expect, it, vi } from 'vitest';

import { enrollFleetNode } from './fleet.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

const REGISTER_URL = 'https://agentrelay.com/api/v1/fleet/register';

describe('enrollFleetNode', () => {
  it('exchanges a one-time token for node credentials', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        nodeId: 'node_abc',
        nodeName: 'kjglaptop',
        nodeToken: 'nt_secret',
        relayWorkspaceId: 'rw_123',
        relaycastUrl: 'https://relaycast.example.com/',
        websocketUrl: 'https://relaycast.example.com//v1/node/ws',
      })
    );

    const result = await enrollFleetNode({
      enrollmentToken: '  ocl_node_enr_xyz  ',
      enrollmentUrl: REGISTER_URL,
      name: 'kjglaptop',
      maxAgents: 4,
      capabilities: ['spawn:codex', ' spawn:codex ', ''],
      tags: ['laptop'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(REGISTER_URL);
    expect(calledInit.method).toBe('POST');
    const sentBody = JSON.parse(String(calledInit.body));
    expect(sentBody).toMatchObject({
      enrollmentToken: 'ocl_node_enr_xyz',
      name: 'kjglaptop',
      maxAgents: 4,
      capabilities: ['spawn:codex'],
      tags: ['laptop'],
    });
    expect(typeof sentBody.version).toBe('string');

    expect(result).toMatchObject({
      nodeId: 'node_abc',
      nodeName: 'kjglaptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_123',
      relaycastUrl: 'https://relaycast.example.com',
    });
  });

  it('derives the websocket url when the response omits it', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        nodeId: 'node_abc',
        nodeName: 'n',
        nodeToken: 'nt_secret',
        relayWorkspaceId: 'rw_123',
        relaycastUrl: 'https://relaycast.example.com',
      })
    );

    const result = await enrollFleetNode({
      enrollmentToken: 'ocl_node_enr_xyz',
      enrollmentUrl: REGISTER_URL,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.websocketUrl).toBe('https://relaycast.example.com/v1/node/ws');
  });

  it('throws a clear message when the token is expired/invalid/consumed (401)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Invalid enrollment token' }, { status: 401 }));

    await expect(
      enrollFleetNode({
        enrollmentToken: 'ocl_node_enr_dead',
        enrollmentUrl: REGISTER_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/invalid, expired, or already used/i);
  });

  it('surfaces a rate-limit error on 429', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Rate limit exceeded' }, { status: 429 }));

    await expect(
      enrollFleetNode({
        enrollmentToken: 'ocl_node_enr_xyz',
        enrollmentUrl: REGISTER_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/rate limit/i);
  });

  it('does not dump HTML markup into the error when the URL is wrong (404)', async () => {
    const html = `<!DOCTYPE html><html><body>${'x'.repeat(500)}</body></html>`;
    const fetchImpl = vi.fn(
      async () => new Response(html, { status: 404, headers: { 'content-type': 'text/html' } })
    );

    await expect(
      enrollFleetNode({
        enrollmentToken: 'ocl_node_enr_xyz',
        enrollmentUrl: REGISTER_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/Node enrollment failed: 404/);
  });

  it('rejects a response missing node credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nodeId: 'node_abc' }));

    await expect(
      enrollFleetNode({
        enrollmentToken: 'ocl_node_enr_xyz',
        enrollmentUrl: REGISTER_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/missing node credentials/i);
  });

  it('requires a non-empty enrollment token', async () => {
    await expect(enrollFleetNode({ enrollmentToken: '   ', enrollmentUrl: REGISTER_URL })).rejects.toThrow(
      /enrollment token is required/i
    );
  });
});
