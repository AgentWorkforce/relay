import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureAndRenderSnapshot,
  type AttachSnapshotConnection,
  type AttachSnapshotDeps,
} from './attach.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDeps(overrides: Partial<AttachSnapshotDeps> = {}): {
  deps: AttachSnapshotDeps;
  writes: string[];
} {
  const writes: string[] = [];
  const deps: AttachSnapshotDeps = {
    fetch: vi.fn(async () => new Response('', { status: 200 })),
    writeChunk: (chunk: string) => {
      writes.push(chunk);
    },
    ...overrides,
  };
  return { deps, writes };
}

const conn: AttachSnapshotConnection = { url: 'http://localhost:3889', apiKey: 'k' };

describe('captureAndRenderSnapshot', () => {
  it('writes the decoded ANSI bytes to writeChunk on success', async () => {
    const ansi = '\x1b[2J\x1b[H\x1b[32mhello\x1b[0m';
    const screen = Buffer.from(ansi, 'utf-8').toString('base64');
    const { deps, writes } = makeDeps({
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              format: 'ansi',
              rows: 24,
              cols: 80,
              cursor: [1, 6],
              screen,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      ),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('ok');
    expect(result.rows).toBe(24);
    expect(result.cols).toBe(80);
    expect(result.cursor).toEqual([1, 6]);
    expect(writes).toEqual([ansi]);
  });

  it('hits the snapshot route with format=ansi and the X-API-Key header', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: 'ansi',
            screen: Buffer.from('x', 'utf-8').toString('base64'),
          }),
          { status: 200 }
        )
    );
    const { deps } = makeDeps({ fetch: fetchMock });

    await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3889/api/spawned/Alice/snapshot?format=ansi');
    expect((init as RequestInit).headers).toEqual({ 'X-API-Key': 'k' });
  });

  it('URL-encodes the agent name', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: 'ansi',
            screen: Buffer.from('', 'utf-8').toString('base64'),
          }),
          { status: 200 }
        )
    );
    const { deps } = makeDeps({ fetch: fetchMock });

    await captureAndRenderSnapshot(conn, 'agent name/with slash', deps);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3889/api/spawned/agent%20name%2Fwith%20slash/snapshot?format=ansi');
  });

  it('omits the X-API-Key header when no api key is set', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ screen: Buffer.from('', 'utf-8').toString('base64') }), { status: 200 })
    );
    const { deps } = makeDeps({ fetch: fetchMock });

    await captureAndRenderSnapshot({ url: 'http://localhost:3889' }, 'Alice', deps);

    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({});
  });

  it('returns not_found on HTTP 404 and does not write', async () => {
    const { deps, writes } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 404 })),
    });

    const result = await captureAndRenderSnapshot(conn, 'Ghost', deps);

    expect(result.status).toBe('not_found');
    expect(result.message).toContain('Ghost');
    expect(writes).toEqual([]);
  });

  it('returns no_pty on HTTP 409', async () => {
    const { deps, writes } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 409 })),
    });

    const result = await captureAndRenderSnapshot(conn, 'Headless', deps);

    expect(result.status).toBe('no_pty');
    expect(result.message).toMatch(/headless/i);
    expect(writes).toEqual([]);
  });

  it('returns unavailable on 5xx', async () => {
    const { deps } = makeDeps({
      fetch: vi.fn(async () => new Response('', { status: 503 })),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('503');
  });

  it('returns transport_error when fetch itself throws', async () => {
    const { deps } = makeDeps({
      fetch: vi.fn(async () => {
        throw new Error('network down');
      }),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('transport_error');
    expect(result.message).toBe('network down');
  });

  it('returns transport_error when the body is not JSON', async () => {
    const { deps } = makeDeps({
      fetch: vi.fn(async () => new Response('not json', { status: 200 })),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('transport_error');
    expect(result.message).toMatch(/not JSON/i);
  });

  it('returns transport_error when the screen field is missing', async () => {
    const { deps } = makeDeps({
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ format: 'ansi', rows: 24, cols: 80 }), { status: 200 })
      ),
    });

    const result = await captureAndRenderSnapshot(conn, 'Alice', deps);

    expect(result.status).toBe('transport_error');
    expect(result.message).toMatch(/missing 'screen' field/);
  });

  it('strips a trailing slash from the connection URL', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ screen: Buffer.from('', 'utf-8').toString('base64') }), { status: 200 })
    );
    const { deps } = makeDeps({ fetch: fetchMock });

    await captureAndRenderSnapshot({ url: 'http://localhost:3889/', apiKey: 'k' }, 'Alice', deps);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3889/api/spawned/Alice/snapshot?format=ansi');
  });
});
