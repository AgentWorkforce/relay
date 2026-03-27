import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const relayFileClientMock = vi.hoisted(() => vi.fn());
const bulkWriteMock = vi.hoisted(() => vi.fn());
const createWorkspaceMock = vi.hoisted(() => vi.fn());

vi.mock('@relayfile/sdk', () => ({
  RelayFileClient: relayFileClientMock.mockImplementation(() => ({
    bulkWrite: bulkWriteMock,
    createWorkspace: createWorkspaceMock,
  })),
}));

import { createWorkspace, seedAclRules, seedWorkspace } from './workspace.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  relayFileClientMock.mockClear();
  bulkWriteMock.mockReset();
  createWorkspaceMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createWorkspace', () => {
  it('tries SDK overloads before falling back to HTTP', async () => {
    createWorkspaceMock
      .mockRejectedValueOnce(new Error('nope-1'))
      .mockRejectedValueOnce(new Error('nope-2'))
      .mockResolvedValueOnce(undefined);

    await createWorkspace('https://relayfile.example/', 'token', ' rw_demo ');

    expect(createWorkspaceMock).toHaveBeenCalledTimes(3);
    expect(createWorkspaceMock).toHaveBeenNthCalledWith(1, 'rw_demo');
    expect(createWorkspaceMock).toHaveBeenNthCalledWith(2, { id: 'rw_demo' });
    expect(createWorkspaceMock).toHaveBeenNthCalledWith(3, { workspaceId: 'rw_demo' });
  });

  it('falls back to HTTP and accepts 409/405 style responses', async () => {
    createWorkspaceMock.mockRejectedValue(new Error('sdk unavailable'));
    const fetchMock = vi.fn().mockResolvedValue({ status: 409, text: async () => 'exists' });
    vi.stubGlobal('fetch', fetchMock);

    await createWorkspace('https://relayfile.example/', 'token', 'rw_demo');

    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('seedWorkspace', () => {
  it('collects files, skips excluded entries, and falls back to HTTP bulk write', async () => {
    const root = makeTempDir('relay-workspace-');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
    mkdirSync(path.join(root, 'custom-ignore'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'hello.txt'), 'hello world\n');
    writeFileSync(path.join(root, 'src', 'bin.dat'), Buffer.from([0xff, 0x00, 0xaa]));
    writeFileSync(path.join(root, '.relayfile-mount-state.json'), '{}');
    writeFileSync(path.join(root, 'custom-ignore', 'skip.txt'), 'skip');
    symlinkSync(path.join(root, 'src', 'hello.txt'), path.join(root, 'linked-hello.txt'));

    bulkWriteMock.mockRejectedValue({ status: undefined });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ written: 3, errorCount: 0, errors: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const written = await seedWorkspace('https://relayfile.example/', 'token', 'rw_demo', root, ['custom-ignore']);

    expect(written).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/workspaces/rw_demo/fs/bulk');
    const payload = JSON.parse(String(init.body));
    expect(payload.files).toHaveLength(3);
    expect(payload.files.map((f: { path: string }) => f.path)).toEqual(['/linked-hello.txt', '/src/bin.dat', '/src/hello.txt']);
    expect(payload.files.find((f: { path: string }) => f.path === '/src/bin.dat').encoding).toBe('base64');
    expect(payload.files.find((f: { path: string }) => f.path === '/src/hello.txt').encoding).toBe('utf-8');
  });
});

describe('seedAclRules', () => {
  it('writes acl files and throws on partial failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ written: 2, errorCount: 0, errors: [] }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ written: 1, errorCount: 1, errors: [{ path: '/src/.relayfile.acl' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    bulkWriteMock.mockRejectedValue({ status: undefined });

    await expect(
      seedAclRules('https://relayfile.example/', 'token', 'rw_demo', {
        '/': ['read'],
        '/src': ['read', 'write'],
      })
    ).resolves.toBeUndefined();

    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(firstPayload.files).toEqual([
      { path: '/.relayfile.acl', content: JSON.stringify({ semantics: { permissions: ['read'] } }), encoding: 'utf-8' },
      { path: '/src/.relayfile.acl', content: JSON.stringify({ semantics: { permissions: ['read', 'write'] } }), encoding: 'utf-8' },
    ]);

    await expect(seedAclRules('https://relayfile.example/', 'token', 'rw_demo', { '/src': ['read'] })).rejects.toThrow(
      'ACL seeding had 1 error(s)'
    );
  });
});
