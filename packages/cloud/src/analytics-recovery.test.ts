import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverStoredCloudIdentity, refreshStoredCloudIdentity } from './auth.js';
import { AUTH_FILE_PATH } from './types.js';
import { clearStoredIdentity, readStoredIdentity, writeStoredIdentity } from './identity.js';

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
  const read = fsp.readFile;
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
});
