import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bulkWriteMock = vi.hoisted(() => vi.fn());
const relayFileClientMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('@relayfile/sdk', () => ({
  RelayFileClient: relayFileClientMock.mockImplementation(() => ({
    bulkWrite: bulkWriteMock,
  })),
}));

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

import { seedWorkspaceTar } from '../seeder.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function listRelativeFiles(rootDir: string, currentDir = rootDir): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRelativeFiles(rootDir, absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(path.relative(rootDir, absolutePath).split(path.sep).join('/'));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function extractTarballEntries(body: unknown): Promise<string[]> {
  const archiveDir = makeTempDir('relay-tar-archive-');
  const extractDir = makeTempDir('relay-tar-extract-');
  const archivePath = path.join(archiveDir, 'seed.tar.gz');

  fs.writeFileSync(archivePath, Buffer.from(body as Uint8Array));
  await tar.extract({ file: archivePath, cwd: extractDir, gzip: true });

  return listRelativeFiles(extractDir);
}

afterEach(() => {
  bulkWriteMock.mockReset();
  relayFileClientMock.mockClear();
  execSyncMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('seedWorkspaceTar', () => {
  it('creates and uploads a tar.gz to the import endpoint and respects excludeDirs', async () => {
    const projectDir = makeTempDir('relay-seed-project-');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'ignored'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'left-pad'), { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'src', 'hello.txt'), 'hello world\n');
    fs.writeFileSync(path.join(projectDir, 'src', 'data.bin'), Buffer.from([0xff, 0x00, 0xaa]));
    fs.writeFileSync(path.join(projectDir, 'ignored', 'skip.txt'), 'skip me\n');
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(projectDir, '.relayfile-mount-state.json'), '{}\n');

    execSyncMock.mockReturnValue(
      [
        'src/hello.txt',
        'src/data.bin',
        'ignored/skip.txt',
        'node_modules/left-pad/index.js',
        '.relayfile-mount-state.json',
      ].join('\0')
    );

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ imported: 2 }));
    vi.stubGlobal('fetch', fetchMock);

    const imported = await seedWorkspaceTar('https://relayfile.example/', 'token', 'rw_demo', projectDir, [
      'ignored',
    ]);

    expect(imported).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/workspaces/rw_demo/fs/import');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token',
      'Content-Type': 'application/gzip',
      'X-Correlation-Id': expect.stringMatching(/^seed-tar-rw_demo-/),
    });
    expect(init.body).toBeInstanceOf(Uint8Array);

    const entries = await extractTarballEntries(init.body);
    expect(entries).toEqual(expect.arrayContaining(['src/data.bin', 'src/hello.txt']));
    expect(entries).not.toContain('ignored/skip.txt');
    expect(entries).not.toContain('node_modules/left-pad/index.js');
    expect(entries).not.toContain('.relayfile-mount-state.json');
  });

  it('falls back to seedWorkspace when the import endpoint returns 404', async () => {
    const projectDir = makeTempDir('relay-seed-project-');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'hello.txt'), 'hello fallback\n');

    execSyncMock.mockReturnValue('src/hello.txt\0');
    bulkWriteMock.mockRejectedValue({ status: undefined });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ written: 1, errorCount: 0, errors: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const imported = await seedWorkspaceTar('https://relayfile.example/', 'token', 'rw_demo', projectDir, []);

    expect(imported).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/workspaces/rw_demo/fs/import');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/workspaces/rw_demo/fs/bulk');

    const payload = JSON.parse(String(fetchMock.mock.calls[1]?.[1].body));
    expect(payload.files).toEqual([
      { path: '/src/hello.txt', content: 'hello fallback\n', encoding: 'utf-8' },
    ]);
  });

  it('throws on non-404 HTTP errors', async () => {
    const projectDir = makeTempDir('relay-seed-project-');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'hello.txt'), 'hello\n');

    execSyncMock.mockReturnValue('src/hello.txt\0');

    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      seedWorkspaceTar('https://relayfile.example/', 'token', 'rw_demo', projectDir, [])
    ).rejects.toThrow('tar import failed for workspace rw_demo: HTTP 500 boom');
  });

  it('works for non-git directories via the directory-walk fallback path', async () => {
    const projectDir = makeTempDir('relay-seed-project-');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'nested', 'docs'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'custom-ignore'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'left-pad'), { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'src', 'app.ts'), 'export const app = true;\n');
    fs.writeFileSync(path.join(projectDir, 'nested', 'docs', 'readme.md'), '# hello\n');
    fs.writeFileSync(path.join(projectDir, 'custom-ignore', 'skip.txt'), 'skip\n');
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(projectDir, '.relayfile-mount-state.json'), '{}\n');

    execSyncMock.mockImplementation(() => {
      throw new Error('not a git repo');
    });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ imported: 2 }));
    vi.stubGlobal('fetch', fetchMock);

    const imported = await seedWorkspaceTar('https://relayfile.example/', 'token', 'rw_demo', projectDir, [
      'custom-ignore',
    ]);

    expect(imported).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0];
    const entries = await extractTarballEntries(init.body);
    expect(entries).toEqual(expect.arrayContaining(['nested/docs/readme.md', 'src/app.ts']));
    expect(entries).not.toContain('custom-ignore/skip.txt');
    expect(entries).not.toContain('node_modules/left-pad/index.js');
    expect(entries).not.toContain('.relayfile-mount-state.json');
  });

  it('includes untracked files returned by git ls-files and preserves gitignore filtering', async () => {
    const projectDir = makeTempDir('relay-seed-project-');
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'ignored-by-git'), { recursive: true });

    fs.writeFileSync(path.join(projectDir, 'src', 'tracked.ts'), 'export const tracked = true;\n');
    fs.writeFileSync(path.join(projectDir, 'src', 'draft.ts'), 'export const draft = true;\n');
    fs.writeFileSync(path.join(projectDir, 'ignored-by-git', 'skip.txt'), 'skip\n');

    execSyncMock.mockReturnValue(['src/tracked.ts', 'src/draft.ts'].join('\0'));

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ imported: 2 }));
    vi.stubGlobal('fetch', fetchMock);

    const imported = await seedWorkspaceTar('https://relayfile.example/', 'token', 'rw_demo', projectDir, []);

    expect(imported).toBe(2);
    expect(execSyncMock).toHaveBeenCalledWith(
      'git ls-files -z --cached --others --exclude-standard',
      expect.objectContaining({ cwd: path.resolve(projectDir), encoding: 'utf-8' })
    );

    const [, init] = fetchMock.mock.calls[0];
    const entries = await extractTarballEntries(init.body);
    expect(entries).toEqual(['src/draft.ts', 'src/tracked.ts']);
    expect(entries).not.toContain('ignored-by-git/skip.txt');
  });

  it('does not fall back to a directory walk when git ls-files succeeds with no files', async () => {
    const projectDir = makeTempDir('relay-seed-project-');
    fs.mkdirSync(path.join(projectDir, 'ignored-by-git'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'ignored-by-git', 'skip.txt'), 'skip\n');

    execSyncMock.mockReturnValue('');

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ imported: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    const imported = await seedWorkspaceTar('https://relayfile.example/', 'token', 'rw_demo', projectDir, []);

    expect(imported).toBe(0);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
