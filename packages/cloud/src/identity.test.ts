import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  IDENTITY_ENV_KEYS,
  cloudIdentityEnv,
  cloudIdentityFingerprint,
  clearStoredIdentity,
  identityFilePath,
  normalizeCloudIdentity,
  readStoredIdentity,
  readStoredIdentitySync,
  resolveCloudIdentity,
  writeStoredIdentity,
  type CloudIdentity,
} from './identity.js';

const IDENTITY: CloudIdentity = {
  userId: 'usr_abc123',
  email: 'will@agentrelay.com',
  name: 'Will',
  organizationId: 'org_xyz789',
  organizationSlug: 'agentworkforce',
  organizationName: 'Agent Workforce',
  organizationRole: 'owner',
  workspaceId: 'ws_123',
  apiUrl: 'https://api.agentrelay.com',
  updatedAt: '2026-07-25T00:00:00.000Z',
};

let dataDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'relay-identity-'));
  env = { AGENT_RELAY_DATA_DIR: dataDir };
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('normalizeCloudIdentity', () => {
  it('requires a usable userId', () => {
    expect(normalizeCloudIdentity({ email: 'a@b.com' })).toBeNull();
    expect(normalizeCloudIdentity({ userId: '   ' })).toBeNull();
    expect(normalizeCloudIdentity(null)).toBeNull();
    expect(normalizeCloudIdentity('usr_1')).toBeNull();
  });

  it('drops fields carrying control characters rather than truncating them', () => {
    const normalized = normalizeCloudIdentity({
      userId: 'usr_1',
      email: 'evil\r\nX-Inject: bad',
      organizationSlug: 'ok-slug',
      apiUrl: 'https://api.agentrelay.com',
    });

    expect(normalized).toMatchObject({ userId: 'usr_1', organizationSlug: 'ok-slug' });
    expect(normalized?.email).toBeUndefined();
  });

  it('rejects an identity whose userId itself is unsafe', () => {
    expect(normalizeCloudIdentity({ userId: 'usr\n1', apiUrl: 'https://x' })).toBeNull();
  });

  it('caps long values', () => {
    const normalized = normalizeCloudIdentity({
      userId: 'u'.repeat(500),
      apiUrl: 'https://api.agentrelay.com',
    });
    expect(normalized?.userId).toHaveLength(128);
  });
});

describe('identityFilePath', () => {
  it('honors AGENT_RELAY_DATA_DIR', () => {
    expect(identityFilePath(env)).toBe(path.join(dataDir, 'cloud-identity.json'));
  });

  it('falls back to the shared relay data dir', () => {
    expect(identityFilePath({})).toBe(
      path.join(os.homedir(), '.agentworkforce/relay', 'cloud-identity.json')
    );
  });
});

describe('writeStoredIdentity / readStoredIdentity', () => {
  it('round-trips an identity with owner-only permissions', async () => {
    await writeStoredIdentity(IDENTITY, env);

    expect(await readStoredIdentity(env)).toEqual(IDENTITY);
    expect(readStoredIdentitySync(env)).toEqual(IDENTITY);

    const mode = fs.statSync(identityFilePath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no temp file behind', async () => {
    await writeStoredIdentity(IDENTITY, env);
    expect(fs.readdirSync(dataDir)).toEqual(['cloud-identity.json']);
  });

  it('refuses to persist an identity with no userId', async () => {
    await writeStoredIdentity({ ...IDENTITY, userId: '' }, env);
    expect(await readStoredIdentity(env)).toBeNull();
  });

  it('returns null for a missing or malformed file', async () => {
    expect(await readStoredIdentity(env)).toBeNull();

    await fsp.writeFile(identityFilePath(env), 'not json');
    expect(await readStoredIdentity(env)).toBeNull();
    expect(readStoredIdentitySync(env)).toBeNull();
  });

  it('clears the stored identity', async () => {
    await writeStoredIdentity(IDENTITY, env);
    await clearStoredIdentity(env);
    expect(await readStoredIdentity(env)).toBeNull();
  });

  it('clearing a missing identity is not an error', async () => {
    await expect(clearStoredIdentity(env)).resolves.toBeUndefined();
  });
});

describe('resolveCloudIdentity', () => {
  it('prefers env vars so a child process inherits its parent identity', async () => {
    await writeStoredIdentity(IDENTITY, env);

    const resolved = resolveCloudIdentity({
      ...env,
      [IDENTITY_ENV_KEYS.userId]: 'usr_from_env',
      [IDENTITY_ENV_KEYS.organizationId]: 'org_from_env',
    });

    expect(resolved?.userId).toBe('usr_from_env');
    expect(resolved?.organizationId).toBe('org_from_env');
  });

  it('falls back to the file when no env identity is published', async () => {
    await writeStoredIdentity(IDENTITY, env);
    expect(resolveCloudIdentity(env)?.userId).toBe(IDENTITY.userId);
  });

  it('returns null when the user is not logged in', () => {
    expect(resolveCloudIdentity(env)).toBeNull();
  });

  it('ignores a malformed env user id instead of trusting it', async () => {
    await writeStoredIdentity(IDENTITY, env);
    const resolved = resolveCloudIdentity({
      ...env,
      [IDENTITY_ENV_KEYS.userId]: 'usr\n1',
    });
    // Falls through to the file rather than propagating an unsafe value.
    expect(resolved?.userId).toBe(IDENTITY.userId);
  });
});

describe('cloudIdentityEnv', () => {
  it('publishes every known field', () => {
    expect(cloudIdentityEnv(IDENTITY)).toEqual({
      AGENT_RELAY_USER_ID: 'usr_abc123',
      AGENT_RELAY_USER_EMAIL: 'will@agentrelay.com',
      AGENT_RELAY_ORG_ID: 'org_xyz789',
      AGENT_RELAY_ORG_SLUG: 'agentworkforce',
      AGENT_RELAY_CLOUD_WORKSPACE_ID: 'ws_123',
    });
  });

  it('omits unset fields and handles no identity', () => {
    expect(cloudIdentityEnv({ userId: 'usr_1', apiUrl: '', updatedAt: '' })).toEqual({
      AGENT_RELAY_USER_ID: 'usr_1',
    });
    expect(cloudIdentityEnv(null)).toEqual({});
  });
});

describe('cloudIdentityFingerprint', () => {
  it('changes when the org changes so identify is re-issued', () => {
    const a = cloudIdentityFingerprint(IDENTITY);
    const b = cloudIdentityFingerprint({ ...IDENTITY, organizationId: 'org_other' });
    expect(a).not.toBe(b);
  });

  it('changes when the email changes', () => {
    expect(cloudIdentityFingerprint(IDENTITY)).not.toBe(
      cloudIdentityFingerprint({ ...IDENTITY, email: 'other@agentrelay.com' })
    );
  });

  it('is stable across unrelated changes so identify is skipped', () => {
    expect(cloudIdentityFingerprint(IDENTITY)).toBe(
      cloudIdentityFingerprint({ ...IDENTITY, updatedAt: '2030-01-01T00:00:00.000Z' })
    );
  });

  it('is undefined without an identity', () => {
    expect(cloudIdentityFingerprint(null)).toBeUndefined();
  });
});
