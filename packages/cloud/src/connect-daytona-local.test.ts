import { describe, expect, it, vi } from 'vitest';

import {
  connectDaytonaLocal,
  daytonaConfigPath,
  extractDaytonaCredential,
  readDaytonaCredential,
  type DaytonaLocalRuntime,
} from './connect-daytona-local.js';

const HOME = '/home/u';
const homedir = () => HOME;

function configWith(token: unknown, orgId: unknown = null, activeProfile = 'p1') {
  return {
    activeProfile,
    profiles: [{ id: 'p1', api: { token }, activeOrganizationId: orgId }],
  };
}

describe('daytonaConfigPath', () => {
  it('resolves the macOS path', () => {
    expect(daytonaConfigPath({}, 'darwin', homedir)).toBe(
      '/home/u/Library/Application Support/daytona/config.json'
    );
  });

  it('resolves the Linux XDG path (default and override)', () => {
    expect(daytonaConfigPath({}, 'linux', homedir)).toBe('/home/u/.config/daytona/config.json');
    expect(daytonaConfigPath({ XDG_CONFIG_HOME: '/xdg' }, 'linux', homedir)).toBe('/xdg/daytona/config.json');
  });

  it('resolves the Windows APPDATA path', () => {
    expect(daytonaConfigPath({ APPDATA: 'C:\\AppData' }, 'win32', homedir)).toBe(
      'C:\\AppData\\daytona\\config.json'
    );
  });

  it('honors DAYTONA_CONFIG_DIR over the platform default', () => {
    expect(daytonaConfigPath({ DAYTONA_CONFIG_DIR: '/custom' }, 'linux', homedir)).toBe(
      '/custom/config.json'
    );
  });
});

describe('extractDaytonaCredential', () => {
  const token = { accessToken: 'a', refreshToken: 'r', expiresAt: '2026-06-12T00:00:00Z' };

  it('normalizes the active profile token and preserves the ISO expiry', () => {
    const cred = extractDaytonaCredential(configWith(token, 'org-1'));
    expect(cred).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: '2026-06-12T00:00:00Z',
      orgId: 'org-1',
    });
  });

  it('omits orgId when activeOrganizationId is null/empty', () => {
    expect(extractDaytonaCredential(configWith(token, null)).orgId).toBeUndefined();
    expect(extractDaytonaCredential(configWith(token, '')).orgId).toBeUndefined();
  });

  it('selects the active profile by id, not just the first', () => {
    const config = {
      activeProfile: 'p2',
      profiles: [
        { id: 'p1', api: { token: { accessToken: 'x', refreshToken: 'x', expiresAt: 'x' } } },
        { id: 'p2', api: { token }, activeOrganizationId: 'org-2' },
      ],
    };
    expect(extractDaytonaCredential(config)).toMatchObject({ accessToken: 'a', orgId: 'org-2' });
  });

  it('falls back to the first profile when activeProfile is absent', () => {
    const config = { profiles: [{ id: 'p1', api: { token } }] };
    expect(extractDaytonaCredential(config).accessToken).toBe('a');
  });

  it('throws when there are no profiles', () => {
    expect(() => extractDaytonaCredential({ profiles: [] })).toThrow(/No Daytona profiles/);
  });

  it('throws on an incomplete token (api-key login has no refresh token)', () => {
    expect(() => extractDaytonaCredential(configWith({ accessToken: 'a' }))).toThrow(
      /no complete OAuth token/
    );
  });
});

describe('readDaytonaCredential', () => {
  const token = { accessToken: 'a', refreshToken: 'r', expiresAt: 'iso' };

  it('reads and extracts from config.json', async () => {
    const read = vi.fn().mockResolvedValue(JSON.stringify(configWith(token, 'o')));
    await expect(readDaytonaCredential('/cfg', read)).resolves.toMatchObject({ orgId: 'o' });
    expect(read).toHaveBeenCalledWith('/cfg');
  });

  it('throws a helpful error when the config is unreadable', async () => {
    const read = vi.fn().mockRejectedValue(new Error('ENOENT'));
    await expect(readDaytonaCredential('/cfg', read)).rejects.toThrow(/Could not read Daytona config/);
  });

  it('throws when the config is not valid JSON', async () => {
    const read = vi.fn().mockResolvedValue('{ not json');
    await expect(readDaytonaCredential('/cfg', read)).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the config is not a JSON object', async () => {
    const read = vi.fn().mockResolvedValue('null');
    await expect(readDaytonaCredential('/cfg', read)).rejects.toThrow(/valid JSON object/);
  });
});

describe('connectDaytonaLocal', () => {
  const silentIo = { log: () => {}, error: () => {} };
  const token = { accessToken: 'a', refreshToken: 'r', expiresAt: 'iso' };

  function runtime(overrides: Partial<DaytonaLocalRuntime> = {}): DaytonaLocalRuntime {
    return {
      hasDaytonaCli: vi.fn().mockResolvedValue(true),
      runLogin: vi.fn().mockResolvedValue(0),
      readConfig: vi.fn().mockResolvedValue(JSON.stringify(configWith(token, 'org-9'))),
      configPath: vi.fn().mockReturnValue('/cfg'),
      upload: vi.fn().mockResolvedValue(true),
      ...overrides,
    };
  }

  it('captures locally and uploads the normalized credential', async () => {
    const upload = vi.fn().mockResolvedValue(true);
    const rt = runtime({ upload });
    const result = await connectDaytonaLocal({ apiUrl: 'https://api', io: silentIo, runtime: rt });
    expect(result).toEqual({ provider: 'daytona', success: true });
    expect(upload).toHaveBeenCalledWith(
      { accessToken: 'a', refreshToken: 'r', expiresAt: 'iso', orgId: 'org-9' },
      'https://api'
    );
  });

  it('errors when the daytona CLI is missing (no login attempted)', async () => {
    const runLogin = vi.fn();
    const rt = runtime({ hasDaytonaCli: vi.fn().mockResolvedValue(false), runLogin });
    await expect(connectDaytonaLocal({ io: silentIo, runtime: rt })).rejects.toThrow(/Daytona CLI not found/);
    expect(runLogin).not.toHaveBeenCalled();
  });

  it('errors when `daytona login` exits non-zero (no upload)', async () => {
    const upload = vi.fn();
    const rt = runtime({ runLogin: vi.fn().mockResolvedValue(1), upload });
    await expect(connectDaytonaLocal({ io: silentIo, runtime: rt })).rejects.toThrow(/exited with code 1/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('errors when the upload fails', async () => {
    const rt = runtime({ upload: vi.fn().mockResolvedValue(false) });
    await expect(connectDaytonaLocal({ io: silentIo, runtime: rt })).rejects.toThrow(/Failed to store/);
  });
});
