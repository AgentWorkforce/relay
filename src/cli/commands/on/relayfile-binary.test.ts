import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_HOME = vi.hoisted(() => '/tmp/agent-relay-relayfile-binary-test-home');
const ORIGINAL_RELAYFILE_ROOT = process.env.RELAYFILE_ROOT;
const platformMock = vi.hoisted(() => vi.fn(() => 'linux'));
const archMock = vi.hoisted(() => vi.fn(() => 'x64'));
const homedirMock = vi.hoisted(() => vi.fn(() => '/tmp/agent-relay-relayfile-binary-test-home'));
const httpsGetMock = vi.hoisted(() => vi.fn());
const fsMocks = vi.hoisted(() => ({
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  createWriteStream: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    arch: archMock,
    homedir: homedirMock,
    platform: platformMock,
    default: {
      ...actual,
      arch: archMock,
      homedir: homedirMock,
      platform: platformMock,
    },
  };
});

vi.mock('node:https', async () => {
  const actual = await vi.importActual<typeof import('node:https')>('node:https');
  return {
    ...actual,
    get: httpsGetMock,
    default: {
      ...actual,
      get: httpsGetMock,
    },
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    accessSync: fsMocks.accessSync,
    chmodSync: fsMocks.chmodSync,
    createWriteStream: fsMocks.createWriteStream,
    existsSync: fsMocks.existsSync,
    mkdirSync: fsMocks.mkdirSync,
    readFileSync: fsMocks.readFileSync,
    renameSync: fsMocks.renameSync,
    rmSync: fsMocks.rmSync,
    writeFileSync: fsMocks.writeFileSync,
  };
});

import { ensureRelayfileMountBinary } from './relayfile-binary.js';

type QueuedResponse = {
  body?: Buffer | string;
  headers?: Record<string, string>;
  statusCode?: number;
  url?: RegExp | string;
};

let realFs: typeof import('node:fs');
let requestedUrls: string[] = [];
let queuedResponses: QueuedResponse[] = [];

function getCachePaths(relayfileRoot?: string) {
  const cacheDir = relayfileRoot ? path.join(relayfileRoot, 'bin') : path.join(TEST_HOME, '.agent-relay', 'bin');
  return {
    cacheDir,
    cachePath: path.join(cacheDir, 'relayfile-mount'),
    versionPath: path.join(cacheDir, 'relayfile-mount.version'),
  };
}

function queueResponse(response: QueuedResponse): void {
  queuedResponses.push(response);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

beforeAll(async () => {
  realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
});

beforeEach(() => {
  requestedUrls = [];
  queuedResponses = [];
  realFs.rmSync(TEST_HOME, { recursive: true, force: true });
  realFs.mkdirSync(TEST_HOME, { recursive: true });
  delete process.env.RELAYFILE_ROOT;

  platformMock.mockReset();
  archMock.mockReset();
  homedirMock.mockReset();
  httpsGetMock.mockReset();
  Object.values(fsMocks).forEach((mock) => mock.mockReset());

  platformMock.mockReturnValue('linux');
  archMock.mockReturnValue('x64');
  homedirMock.mockReturnValue(TEST_HOME);

  fsMocks.accessSync.mockImplementation(realFs.accessSync as any);
  fsMocks.chmodSync.mockImplementation(realFs.chmodSync as any);
  fsMocks.createWriteStream.mockImplementation((filePath: string, options?: { mode?: number }) => {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      final(callback) {
        realFs.writeFileSync(filePath, Buffer.concat(chunks), { mode: options?.mode });
        callback();
      },
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
        callback();
      },
    }) as Writable & { close: (callback: () => void) => void };

    stream.close = (callback: () => void) => {
      callback();
    };

    return stream as any;
  });
  fsMocks.existsSync.mockImplementation(realFs.existsSync as any);
  fsMocks.mkdirSync.mockImplementation(realFs.mkdirSync as any);
  fsMocks.readFileSync.mockImplementation(realFs.readFileSync as any);
  fsMocks.renameSync.mockImplementation(realFs.renameSync as any);
  fsMocks.rmSync.mockImplementation(realFs.rmSync as any);
  fsMocks.writeFileSync.mockImplementation(realFs.writeFileSync as any);

  httpsGetMock.mockImplementation((url: string | URL, callback: (res: Readable) => void) => {
    const currentUrl = String(url);
    requestedUrls.push(currentUrl);

    const nextResponse = queuedResponses.shift();
    if (!nextResponse) {
      throw new Error(`Unexpected https.get call for ${currentUrl}`);
    }

    if (typeof nextResponse.url === 'string') {
      expect(currentUrl).toBe(nextResponse.url);
    } else if (nextResponse.url) {
      expect(currentUrl).toMatch(nextResponse.url);
    }

    const response = Readable.from(nextResponse.body === undefined ? [] : [nextResponse.body]) as Readable & {
      headers: Record<string, string>;
      statusCode?: number;
    };
    response.statusCode = nextResponse.statusCode ?? 200;
    response.headers = nextResponse.headers ?? {};

    const request = new EventEmitter() as ClientRequest;
    queueMicrotask(() => {
      callback(response);
    });

    return request;
  });
});

afterEach(() => {
  realFs.rmSync(TEST_HOME, { recursive: true, force: true });
  if (ORIGINAL_RELAYFILE_ROOT === undefined) {
    delete process.env.RELAYFILE_ROOT;
  } else {
    process.env.RELAYFILE_ROOT = ORIGINAL_RELAYFILE_ROOT;
  }
});

describe('ensureRelayfileMountBinary', () => {
  it('downloads the platform-specific binary and writes it to the cache', async () => {
    const binaryName = 'relayfile-mount-linux-amd64';
    queueResponse({
      body: 'relayfile-binary',
      url: /\/relayfile-mount-linux-amd64$/,
    });
    queueResponse({
      body: `${sha256('relayfile-binary')}  ${binaryName}\n`,
      url: /\/checksums\.txt$/,
    });

    const installedPath = await ensureRelayfileMountBinary();
    const { cachePath, versionPath } = getCachePaths();

    expect(installedPath).toBe(cachePath);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toMatch(/\/relayfile-mount-linux-amd64$/);
    expect(requestedUrls[1]).toMatch(/\/checksums\.txt$/);
    expect(realFs.readFileSync(cachePath, 'utf8')).toBe('relayfile-binary');
    expect(realFs.readFileSync(versionPath, 'utf8')).toBe('0.1.6\n');
  });

  it('reuses the cached binary when the version matches', async () => {
    const { cacheDir, cachePath, versionPath } = getCachePaths();
    realFs.mkdirSync(cacheDir, { recursive: true });
    realFs.writeFileSync(cachePath, 'cached-binary', 'utf8');
    realFs.chmodSync(cachePath, 0o755);
    realFs.writeFileSync(versionPath, '0.1.6\n', 'utf8');

    await expect(ensureRelayfileMountBinary()).resolves.toBe(cachePath);
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(realFs.readFileSync(cachePath, 'utf8')).toBe('cached-binary');
  });

  it('installs the binary under RELAYFILE_ROOT/bin when overridden', async () => {
    const relayfileRoot = path.join(TEST_HOME, 'custom-relayfile');
    const binaryName = 'relayfile-mount-linux-amd64';
    process.env.RELAYFILE_ROOT = relayfileRoot;
    queueResponse({
      body: 'relayfile-binary',
      url: /\/relayfile-mount-linux-amd64$/,
    });
    queueResponse({
      body: `${sha256('relayfile-binary')}  ${binaryName}\n`,
      url: /\/checksums\.txt$/,
    });

    const installedPath = await ensureRelayfileMountBinary();
    const { cachePath, versionPath } = getCachePaths(relayfileRoot);

    expect(installedPath).toBe(cachePath);
    expect(realFs.readFileSync(cachePath, 'utf8')).toBe('relayfile-binary');
    expect(realFs.readFileSync(versionPath, 'utf8')).toBe('0.1.6\n');
    expect(realFs.existsSync(getCachePaths().cachePath)).toBe(false);
  });

  it('throws when the downloaded binary checksum does not match', async () => {
    const binaryName = 'relayfile-mount-linux-amd64';
    const { cacheDir, cachePath, versionPath } = getCachePaths();
    queueResponse({
      body: 'corrupt-binary',
      url: /\/relayfile-mount-linux-amd64$/,
    });
    queueResponse({
      body: `${'0'.repeat(64)}  ${binaryName}\n`,
      url: /\/checksums\.txt$/,
    });

    await expect(ensureRelayfileMountBinary()).rejects.toThrow(
      `Checksum mismatch for ${binaryName}: expected ${'0'.repeat(64)}, got ${sha256('corrupt-binary')}`
    );

    expect(realFs.existsSync(cachePath)).toBe(false);
    expect(realFs.existsSync(versionPath)).toBe(false);
    expect(realFs.existsSync(cacheDir) ? realFs.readdirSync(cacheDir).filter((entry) => entry.includes('.download')) : []).toEqual([]);
  });
});
