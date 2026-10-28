import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverStoredCloudIdentity, refreshStoredCloudIdentity } from './auth.js';
import { AUTH_FILE_PATH, DEFAULT_REFRESH_TIMEOUT_MS } from './types.js';
import { clearStoredIdentity, readStoredIdentity, writeStoredIdentity } from './identity.js';

const nativeReadFile = fsp.readFile.bind(fsp);

const payload = {
  authenticated: true,
  source: 'token',
  subjectType: 'user',
  scopes: [],
  user: { id: 'usr_A', email: 'synthetic@example.test', name: 'Synthetic' },
  currentOrganization: null,
  currentWorkspace: null,
};
const auth = {
  apiUrl: 'https://example.test',
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh',
  accessTokenExpiresAt: '2999-01-01T00:00:00Z',
};
let dataDir: string;
let env: NodeJS.ProcessEnv;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-repair-'));
  env = { AGENT_RELAY_DATA_DIR: dataDir };
  const read = nativeReadFile;
  vi.spyOn(fsp, 'readFile').mockImplementation(((file, options) =>
    String(file) === AUTH_FILE_PATH
      ? Promise.resolve(JSON.stringify(auth))
      : read(file, options)) as typeof fsp.readFile);
  request = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
  vi.stubGlobal('fetch', request);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Cloud-owned analytics profile repair', () => {
  it('requests eligible repair through authenticated whoami without submitting profile PII', async () => {
    await recoverStoredCloudIdentity(env);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe('https://example.test/api/v1/auth/whoami');
    expect(new Headers(init.headers).get('X-Agent-Relay-Analytics')).toBe('enabled');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-access');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
    expect(await readStoredIdentity(env)).toMatchObject({ userId: 'usr_A' });
    await recoverStoredCloudIdentity(env);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries failed repair after a bounded cooldown instead of permanently marking delivery', async () => {
    request.mockResolvedValue(new Response('{}', { status: 503 }));
    await recoverStoredCloudIdentity(env);
    await recoverStoredCloudIdentity(env);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await readStoredIdentity(env)).toBeNull();
    fs.writeFileSync(path.join(dataDir, 'cloud-identity.json.repair'), String(Date.now() - 300_001));
    request.mockImplementation(async () => new Response(JSON.stringify(payload)));
    await recoverStoredCloudIdentity(env);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await readStoredIdentity(env)).toMatchObject({ userId: 'usr_A' });
  });

  it.each(['prefs', 'DO_NOT_TRACK', 'AGENT_RELAY_TELEMETRY_DISABLED'])(
    'does not request repair when opted out via %s',
    async (source) => {
      if (source === 'prefs') fs.writeFileSync(path.join(dataDir, 'telemetry.json'), '{"enabled":false}');
      else env[source] = '1';
      await recoverStoredCloudIdentity(env);
      expect(request).not.toHaveBeenCalled();
      await refreshStoredCloudIdentity(auth, { env });
      expect(new Headers(request.mock.calls[0][1].headers).has('X-Agent-Relay-Analytics')).toBe(false);
    }
  );

  it('does not resurrect a signed-out identity when an earlier whoami finishes late', async () => {
    let release!: (response: Response) => void;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const pending = refreshStoredCloudIdentity(auth, { env });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await clearStoredIdentity(env);
    release(new Response(JSON.stringify(payload)));
    expect(await pending).toBeNull();
    expect(await readStoredIdentity(env)).toBeNull();
  });

  it('does not overwrite a newer account when an earlier whoami finishes late', async () => {
    let release!: (response: Response) => void;
    request.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const pending = refreshStoredCloudIdentity(auth, { env });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await writeStoredIdentity(
      { userId: 'usr_B', apiUrl: auth.apiUrl, updatedAt: new Date().toISOString() },
      env
    );
    release(new Response(JSON.stringify(payload)));
    expect(await pending).toBeNull();
    expect(await readStoredIdentity(env)).toMatchObject({ userId: 'usr_B' });
  });
  it('rejects an old snapshot whose disk write finishes after logout', async () => {
    const originalRename = fsp.rename;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rename = vi.spyOn(fsp, 'rename').mockImplementation(async (...args) => {
      await blocked;
      return originalRename(...args);
    });
    const pending = refreshStoredCloudIdentity(auth, { env });
    await vi.waitFor(() => expect(rename).toHaveBeenCalled());
    await clearStoredIdentity(env);
    release();
    expect(await pending).toBeNull();
    expect(await readStoredIdentity(env)).toBeNull();
    expect(env.AGENT_RELAY_USER_ID).toBeUndefined();
  });
  it('never sends background repair credentials to an HTTP endpoint', async () => {
    const read = nativeReadFile;
    vi.spyOn(fsp, 'readFile').mockImplementation(((file, options) =>
      String(file) === AUTH_FILE_PATH
        ? Promise.resolve(JSON.stringify({ ...auth, apiUrl: 'http://example.test' }))
        : read(file, options)) as typeof fsp.readFile);
    await recoverStoredCloudIdentity(env);
    expect(request).not.toHaveBeenCalled();
  });

  it('uses a no-redirect transport policy for background repair', async () => {
    await recoverStoredCloudIdentity(env);
    expect(request.mock.calls[0][1].redirect).toBe('error');
  });

  it('rejects credentials read before an account switch during repair marker IO', async () => {
    const read = nativeReadFile;
    vi.spyOn(fsp, 'readFile').mockImplementation((async (file, options) => {
      if (String(file) === AUTH_FILE_PATH) return JSON.stringify(auth);
      if (String(file).endsWith('.repair')) {
        await writeStoredIdentity(
          { userId: 'usr_B', apiUrl: auth.apiUrl, updatedAt: new Date().toISOString() },
          env
        );
        return '0';
      }
      return read(file, options);
    }) as typeof fsp.readFile);
    await recoverStoredCloudIdentity(env);
    expect(request).not.toHaveBeenCalled();
    expect(await readStoredIdentity(env)).toMatchObject({ userId: 'usr_B' });
  });

  it('reserves the short recovery deadline for background repair, not explicit login identity', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await refreshStoredCloudIdentity(auth, { env });
    expect(timeout).toHaveBeenCalledWith(DEFAULT_REFRESH_TIMEOUT_MS);
    expect(timeout).not.toHaveBeenCalledWith(2_000);
  });
  it('does not repair or send profile consent when preferences are malformed', async () => {
    fs.writeFileSync(path.join(dataDir, 'telemetry.json'), '{"enabled":fal');
    await recoverStoredCloudIdentity(env);
    expect(request).not.toHaveBeenCalled();
    await refreshStoredCloudIdentity(auth, { env });
    expect(new Headers(request.mock.calls[0][1].headers).has('X-Agent-Relay-Analytics')).toBe(false);
  });

  it.each(['logout', 'account switch'])(
    'never refreshes old credentials after a delayed repair 401 and %s',
    async (transition) => {
      let release!: (response: Response) => void;
      request.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      );
      // Model canonical credential deletion/replacement without touching the real auth file.
      const mkdir = fsp.mkdir.bind(fsp);
      const rm = fsp.rm.bind(fsp);
      vi.spyOn(fsp, 'mkdir').mockImplementation(((file, options) =>
        [path.dirname(AUTH_FILE_PATH), `${AUTH_FILE_PATH}.lock`].includes(String(file))
          ? Promise.resolve(undefined)
          : mkdir(file, options)) as typeof fsp.mkdir);
      vi.spyOn(fsp, 'rm').mockImplementation((file, options) =>
        String(file) === `${AUTH_FILE_PATH}.lock` ? Promise.resolve() : rm(file, options)
      );
      request.mockImplementation(async () => new Response('{}', { status: 400 }));
      const writes = vi.spyOn(fsp, 'writeFile');
      const pending = recoverStoredCloudIdentity(env);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      await clearStoredIdentity(env);
      if (transition === 'account switch') {
        await writeStoredIdentity(
          { userId: 'usr_B', apiUrl: 'https://other.example.test', updatedAt: new Date().toISOString() },
          env
        );
      }
      vi.mocked(fsp.readFile).mockImplementation(((file, options) => {
        if (String(file) !== AUTH_FILE_PATH) return nativeReadFile(file, options);
        if (transition === 'logout')
          return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        return Promise.resolve(JSON.stringify({ ...auth, apiUrl: 'https://other.example.test' }));
      }) as typeof fsp.readFile);
      release(new Response('{}', { status: 401 }));
      await pending;
      expect(request).toHaveBeenCalledTimes(1);
      expect(writes.mock.calls.some(([file]) => String(file) === AUTH_FILE_PATH)).toBe(false);
      expect((await readStoredIdentity(env))?.userId ?? null).toBe(transition === 'logout' ? null : 'usr_B');
    }
  );
});
