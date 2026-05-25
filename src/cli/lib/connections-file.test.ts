import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONNECTIONS_MANIFEST_VERSION,
  connectionsFilePath,
  readConnectionsManifest,
  upsertConnectionsManifest,
  xdgConfigHome,
} from './connections-file.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'connections-file-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('xdgConfigHome / connectionsFilePath', () => {
  it('prefers the explicit override', () => {
    expect(xdgConfigHome({ xdgConfigHome: tmpRoot })).toBe(tmpRoot);
  });

  it('falls back to ~/.config when nothing is set', () => {
    const home = path.join(tmpRoot, 'fake-home');
    const result = xdgConfigHome({ homeDir: home, xdgConfigHome: '' });
    expect(result).toBe(path.join(home, '.config'));
  });

  it('points at <xdgConfigHome>/agent-relay/connections.json', () => {
    expect(connectionsFilePath({ xdgConfigHome: tmpRoot })).toBe(
      path.join(tmpRoot, 'agent-relay', 'connections.json'),
    );
  });
});

describe('readConnectionsManifest', () => {
  it('returns an empty manifest when the file is missing', async () => {
    const result = await readConnectionsManifest({
      xdgConfigHome: tmpRoot,
      now: () => '2026-05-16T00:00:00.000Z',
    });
    expect(result).toEqual({
      version: CONNECTIONS_MANIFEST_VERSION,
      updatedAt: '2026-05-16T00:00:00.000Z',
      clis: {},
    });
  });

  it('preserves an existing future-incompatible version as opaque', async () => {
    await upsertConnectionsManifest(
      {
        cli: 'claude',
        binPath: '/bin/claude',
        version: '1.0.0',
        rawVersionOutput: 'claude 1.0.0',
        connectedAt: '2026-05-16T00:00:00.000Z',
      },
      { xdgConfigHome: tmpRoot, now: () => '2026-05-16T00:00:00.000Z' },
    );
    // Now hand-write a manifest with version 999.
    const fs = await import('node:fs/promises');
    const manifestPath = connectionsFilePath({ xdgConfigHome: tmpRoot });
    const existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    existing.version = 999;
    await fs.writeFile(manifestPath, JSON.stringify(existing));

    const result = await readConnectionsManifest({ xdgConfigHome: tmpRoot });
    expect(result.version).toBe(999);
    expect(result.clis.claude?.binPath).toBe('/bin/claude');
  });

  it('treats JSON parse failures as missing with a warning', async () => {
    const fs = await import('node:fs/promises');
    const manifestPath = connectionsFilePath({ xdgConfigHome: tmpRoot });
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, 'NOT JSON');

    const warnings: string[] = [];
    const result = await readConnectionsManifest({
      xdgConfigHome: tmpRoot,
      now: () => '2026-05-16T00:00:00.000Z',
      warn: (msg) => warnings.push(msg),
    });
    expect(result.clis).toEqual({});
    expect(warnings).toHaveLength(1);
  });
});

describe('upsertConnectionsManifest', () => {
  it('creates the manifest with mode 0600 and parent dir mode 0700', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const { manifestPath } = await upsertConnectionsManifest(
      {
        cli: 'claude',
        binPath: '/usr/local/bin/claude',
        version: '1.2.3',
        rawVersionOutput: 'claude 1.2.3',
        connectedAt: '2026-05-16T00:00:00.000Z',
      },
      { xdgConfigHome: tmpRoot, now: () => '2026-05-16T00:00:00.000Z' },
    );
    const parentMode = statSync(path.dirname(manifestPath)).mode & 0o777;
    const fileMode = statSync(manifestPath).mode & 0o777;
    expect(parentMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it('idempotently merges entries across multiple writes', async () => {
    const opts = { xdgConfigHome: tmpRoot };
    await upsertConnectionsManifest(
      {
        cli: 'claude',
        binPath: '/bin/claude',
        version: '1.0.0',
        rawVersionOutput: 'claude 1.0.0',
        connectedAt: '2026-05-16T00:00:00.000Z',
      },
      opts,
    );
    await upsertConnectionsManifest(
      {
        cli: 'codex',
        binPath: '/bin/codex',
        version: '0.5.0',
        rawVersionOutput: 'codex 0.5.0',
        connectedAt: '2026-05-16T00:00:01.000Z',
      },
      opts,
    );
    const manifest = await readConnectionsManifest(opts);
    expect(manifest.clis.claude).toBeDefined();
    expect(manifest.clis.codex).toBeDefined();
    expect(manifest.clis.claude?.version).toBe('1.0.0');
    expect(manifest.clis.codex?.version).toBe('0.5.0');
  });

  it('overwrites the same cli entry on re-upsert', async () => {
    const opts = { xdgConfigHome: tmpRoot };
    await upsertConnectionsManifest(
      {
        cli: 'claude',
        binPath: '/bin/claude',
        version: '1.0.0',
        rawVersionOutput: 'claude 1.0.0',
        connectedAt: '2026-05-16T00:00:00.000Z',
      },
      opts,
    );
    await upsertConnectionsManifest(
      {
        cli: 'claude',
        binPath: '/opt/claude',
        version: '1.1.0',
        rawVersionOutput: 'claude 1.1.0',
        connectedAt: '2026-05-17T00:00:00.000Z',
      },
      opts,
    );
    const manifest = await readConnectionsManifest(opts);
    expect(manifest.clis.claude?.binPath).toBe('/opt/claude');
    expect(manifest.clis.claude?.version).toBe('1.1.0');
  });

  it('writes pretty-printed JSON ending with a newline', async () => {
    const { manifestPath } = await upsertConnectionsManifest(
      {
        cli: 'gemini',
        binPath: '/bin/gemini',
        version: '0.1.0',
        rawVersionOutput: 'gemini 0.1.0',
        connectedAt: '2026-05-16T00:00:00.000Z',
      },
      { xdgConfigHome: tmpRoot, now: () => '2026-05-16T00:00:00.000Z' },
    );
    const body = await readFile(manifestPath, 'utf8');
    expect(body.endsWith('\n')).toBe(true);
    expect(body).toContain('  "clis"');
  });

  it('preserves a higher existing manifest version rather than downgrading it on upsert', async () => {
    // Forward-compat: if a future agent-relay release has bumped the manifest
    // version and written additional fields, an older binary that upserts here
    // must not regress the version back to its own (smaller) value.
    // readConnectionsManifest already preserves it on read; upsert must
    // preserve it on write too.
    const opts = { xdgConfigHome: tmpRoot, now: () => '2026-05-16T00:00:00.000Z' };
    await upsertConnectionsManifest(
      {
        cli: 'claude',
        binPath: '/bin/claude',
        version: '1.0.0',
        rawVersionOutput: 'claude 1.0.0',
        connectedAt: '2026-05-16T00:00:00.000Z',
      },
      opts,
    );
    // Hand-bump the on-disk version to a future value.
    const fs = await import('node:fs/promises');
    const manifestPath = connectionsFilePath(opts);
    const existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    existing.version = 999;
    await fs.writeFile(manifestPath, JSON.stringify(existing));
    // Re-upsert with the same CLI; manifest.version must stay at 999.
    const { manifest } = await upsertConnectionsManifest(
      {
        cli: 'codex',
        binPath: '/bin/codex',
        version: '0.5.0',
        rawVersionOutput: 'codex 0.5.0',
        connectedAt: '2026-05-16T00:00:01.000Z',
      },
      opts,
    );
    expect(manifest.version).toBe(999);
    const onDisk = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(onDisk.version).toBe(999);
  });

  it('refreshes updatedAt on each upsert', async () => {
    const opts = (now: string) => ({ xdgConfigHome: tmpRoot, now: () => now });
    await upsertConnectionsManifest(
      {
        cli: 'claude',
        binPath: '/bin/claude',
        version: '1.0.0',
        rawVersionOutput: 'claude 1.0.0',
        connectedAt: '2026-05-16T00:00:00.000Z',
      },
      opts('2026-05-16T00:00:00.000Z'),
    );
    const { manifest } = await upsertConnectionsManifest(
      {
        cli: 'codex',
        binPath: '/bin/codex',
        version: '0.5.0',
        rawVersionOutput: 'codex 0.5.0',
        connectedAt: '2026-05-16T00:00:01.000Z',
      },
      opts('2026-05-17T00:00:00.000Z'),
    );
    expect(manifest.updatedAt).toBe('2026-05-17T00:00:00.000Z');
  });
});
