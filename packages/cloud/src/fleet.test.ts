import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enrollFleetNode,
  fleetNodeEnrollmentStorePath,
  readFleetNodeEnrollmentStore,
  resolveActiveFleetNodeEnrollment,
  upsertFleetNodeEnrollment,
  writeFleetNodeEnrollmentStore,
  type FleetNodeEnrollmentRecord,
} from './fleet.js';

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

  it('rejects a response whose optional fields are the wrong type', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        nodeToken: 'nt_secret',
        relayWorkspaceId: 'rw_123',
        relaycastUrl: 'https://relaycast.example.com',
        // The required trio is present, but a malformed optional field (number,
        // not string) must still be caught by the tightened type guard rather
        // than silently coerced.
        nodeId: 42,
      })
    );

    await expect(
      enrollFleetNode({
        enrollmentToken: 'ocl_node_enr_xyz',
        enrollmentUrl: REGISTER_URL,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/missing node credentials/i);
  });

  it('rejects a response with an empty relayWorkspaceId', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        nodeToken: 'nt_secret',
        relayWorkspaceId: '   ',
        relaycastUrl: 'https://relaycast.example.com',
      })
    );

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

describe('fleet node enrollment store', () => {
  let tmpHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-enroll-test-'));
    env = { ...process.env, AGENT_RELAY_HOME: tmpHome };
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function record(overrides: Partial<FleetNodeEnrollmentRecord> = {}): FleetNodeEnrollmentRecord {
    return {
      nodeId: 'node_1',
      nodeName: 'laptop',
      nodeToken: 'nt_secret',
      relayWorkspaceId: 'rw_1',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'https://relaycast.example.com/v1/node/ws',
      enrolledAt: '2026-07-03T00:00:00.000Z',
      ...overrides,
    };
  }

  it('round-trips a store through write and read', () => {
    const store = {
      version: 1 as const,
      active: { 'https://relaycast.example.com': 'https://relaycast.example.com#rw_1' },
      nodes: { 'https://relaycast.example.com#rw_1': record() },
    };
    writeFleetNodeEnrollmentStore(store, env);
    expect(readFleetNodeEnrollmentStore(env)).toEqual(store);
  });

  it('reads an empty store when the file is missing', () => {
    expect(readFleetNodeEnrollmentStore(env)).toEqual({ version: 1, active: {}, nodes: {} });
  });

  it('upserts a record and resolves it as active', () => {
    upsertFleetNodeEnrollment(record(), env);
    const resolved = resolveActiveFleetNodeEnrollment({ env });
    expect(resolved).toMatchObject({ nodeId: 'node_1', relayWorkspaceId: 'rw_1' });
  });

  it('resolves by baseUrl and workspaceId', () => {
    upsertFleetNodeEnrollment(record({ relayWorkspaceId: 'rw_1', nodeId: 'node_1' }), env);
    upsertFleetNodeEnrollment(record({ relayWorkspaceId: 'rw_2', nodeId: 'node_2' }), env);
    const resolved = resolveActiveFleetNodeEnrollment({
      baseUrl: 'https://relaycast.example.com/',
      workspaceId: 'rw_1',
      env,
    });
    expect(resolved?.nodeId).toBe('node_1');
  });

  it('resolves by workspaceId alone', () => {
    upsertFleetNodeEnrollment(
      record({ relaycastUrl: 'https://a.example.com', relayWorkspaceId: 'rw_a', nodeId: 'node_a' }),
      env
    );
    upsertFleetNodeEnrollment(
      record({ relaycastUrl: 'https://b.example.com', relayWorkspaceId: 'rw_b', nodeId: 'node_b' }),
      env
    );
    const resolved = resolveActiveFleetNodeEnrollment({ workspaceId: 'rw_b', env });
    expect(resolved?.nodeId).toBe('node_b');
  });

  it('resolves a project-associated enrollment by nodeId', () => {
    upsertFleetNodeEnrollment(record({ relayWorkspaceId: 'rw_1', nodeId: 'node_1' }), env);
    upsertFleetNodeEnrollment(record({ relayWorkspaceId: 'rw_2', nodeId: 'node_2' }), env);
    expect(resolveActiveFleetNodeEnrollment({ nodeId: 'node_1', env })?.relayWorkspaceId).toBe('rw_1');
    expect(resolveActiveFleetNodeEnrollment({ nodeId: 'node_missing', env })).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveActiveFleetNodeEnrollment({ env })).toBeUndefined();
    upsertFleetNodeEnrollment(record(), env);
    expect(resolveActiveFleetNodeEnrollment({ workspaceId: 'rw_missing', env })).toBeUndefined();
  });

  it('throws a disambiguation error when multiple records match with no selector', () => {
    upsertFleetNodeEnrollment(
      record({ relaycastUrl: 'https://a.example.com', relayWorkspaceId: 'rw_a', nodeId: 'node_a' }),
      env
    );
    upsertFleetNodeEnrollment(
      record({ relaycastUrl: 'https://b.example.com', relayWorkspaceId: 'rw_b', nodeId: 'node_b' }),
      env
    );
    expect(() => resolveActiveFleetNodeEnrollment({ env })).toThrow(/Multiple fleet node enrollments/);
  });

  it('surfaces a corrupt (invalid JSON) store loudly instead of reading it as empty', () => {
    const file = fleetNodeEnrollmentStorePath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not valid json');
    // A silently-emptied store would let the next upsert erase every stored
    // enrollment — corruption must be surfaced, not papered over.
    expect(() => readFleetNodeEnrollmentStore(env)).toThrow(/corrupt/);
    expect(() => readFleetNodeEnrollmentStore(env)).toThrow(file);
  });

  it('writes atomically: no tmp file remains and the store parses after upsert', () => {
    upsertFleetNodeEnrollment(record(), env);
    const file = fleetNodeEnrollmentStorePath(env);
    const siblings = fs.readdirSync(path.dirname(file));
    expect(siblings.filter((name) => name.includes('.tmp'))).toEqual([]);
    expect(readFleetNodeEnrollmentStore(env).nodes).not.toEqual({});
  });

  it('drops malformed node entries while keeping valid ones', () => {
    const file = fleetNodeEnrollmentStorePath(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        active: {},
        nodes: {
          good: record(),
          bad: { nodeId: 'x' },
        },
      })
    );
    const store = readFleetNodeEnrollmentStore(env);
    expect(Object.keys(store.nodes)).toEqual(['good']);
  });

  it('writes the store file with 0o600 permissions', () => {
    upsertFleetNodeEnrollment(record(), env);
    const file = fleetNodeEnrollmentStorePath(env);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
