import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fileCleanupJournal, type PendingCleanupEntry } from './integration-cleanup-journal.js';

const CONCRETE: PendingCleanupEntry = {
  kind: 'relayfile-webhook-subscription',
  scope: 'relayfile:project-daemon',
  id: 'whsub_1',
};

const INTENT: PendingCleanupEntry = {
  kind: 'subscribe-attempt',
  scope: 'relayfile:project-daemon',
  provider: 'slack',
  resource: '/slack/channels/C0/**',
  url: 'https://cast.test/inbound',
  pathGlobs: ['/slack/channels/C0/**'],
  webhookName: 'relayfile:slack:slack-channels-c0-0123456789:abcdef0123',
  writebackUrl: 'https://ingress.example',
  relayScope: 'relay:abcd',
};

const require = createRequire(import.meta.url);

function tmpJournalDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-journal-'));
}

describe('fileCleanupJournal', () => {
  it('round-trips entries atomically with restrictive permissions', async () => {
    const dir = tmpJournalDir();
    const journal = fileCleanupJournal(dir);

    await journal.update(() => [CONCRETE, INTENT]);
    await expect(journal.list()).resolves.toEqual([CONCRETE, INTENT]);

    const file = path.join(dir, 'pending-cleanups.json');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    // No temp residue after a completed update; the STABLE lock file remains
    // by design (never unlinked or renamed) with restrictive mode and the v2
    // format marker.
    const lock = path.join(dir, 'pending-cleanups.json.lock');
    expect(fs.readdirSync(dir).sort()).toEqual(['pending-cleanups.json', 'pending-cleanups.json.lock']);
    if (process.platform !== 'win32') {
      expect(fs.statSync(lock).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(lock, 'utf8')).toBe('agent-relay-cleanup-lock v2\n');

    await journal.update((entries) => entries.filter((e) => e.kind !== 'relayfile-webhook-subscription'));
    await expect(journal.list()).resolves.toEqual([INTENT]);
  });

  it('supports async mutators, persisting the awaited result under the lock', async () => {
    const dir = tmpJournalDir();
    const journal = fileCleanupJournal(dir);

    await journal.update(async (entries) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [...entries, CONCRETE];
    });

    await expect(journal.list()).resolves.toEqual([CONCRETE]);
  });

  it('does not lose entries under concurrent updates', async () => {
    const dir = tmpJournalDir();
    const journal = fileCleanupJournal(dir);
    const ids = Array.from({ length: 12 }, (_, i) => `whsub_${i}`);

    await Promise.all(ids.map((id) => journal.update((entries) => [...entries, { ...CONCRETE, id }])));

    const entries = await journal.list();
    expect(entries.map((e) => e.id).sort()).toEqual([...ids].sort());
  });

  it('fails closed on non-JSON content without touching the file', async () => {
    const dir = tmpJournalDir();
    const file = path.join(dir, 'pending-cleanups.json');
    fs.writeFileSync(file, 'not json at all');
    const journal = fileCleanupJournal(dir);

    await expect(journal.list()).rejects.toMatchObject({ code: 'corrupt' });
    await expect(journal.update((e) => e)).rejects.toMatchObject({ code: 'corrupt' });
    // The corrupt bytes are preserved for manual inspection.
    expect(fs.readFileSync(file, 'utf8')).toBe('not json at all');
  });

  it('rejects malformed entries (unknown kind, missing id, incomplete intent) as corrupt', async () => {
    const cases: unknown[] = [
      [{ kind: 'mystery-kind', scope: 's', id: 'x' }],
      [{ kind: 'relay-webhook', scope: 's' }], // concrete without id
      [{ kind: 'relayfile-webhook-subscription', scope: '', id: 'x' }], // empty scope
      [{ kind: 'subscribe-attempt', scope: 's', url: 'u' }], // attempt missing keys
      [
        {
          kind: 'subscribe-attempt',
          scope: 's',
          url: 'u',
          provider: 'p',
          resource: 'r',
          webhookName: 'w',
          writebackUrl: 'wb',
          relayScope: 'rs',
          pathGlobs: [],
        },
      ],
      [{ kind: 'relay-webhook', scope: 's', id: 'x', owner: { pid: -1, host: 'h', attemptId: 'a' } }], // invalid owner
      ['just-a-string'],
      { not: 'an array' },
    ];
    for (const content of cases) {
      const dir = tmpJournalDir();
      fs.writeFileSync(path.join(dir, 'pending-cleanups.json'), JSON.stringify(content));
      const journal = fileCleanupJournal(dir);
      await expect(journal.list(), JSON.stringify(content)).rejects.toMatchObject({ code: 'corrupt' });
    }
  });

  it('serializes same-process contenders on separate descriptors', async () => {
    const dir = tmpJournalDir();
    const journal = fileCleanupJournal(dir);
    // flock excludes between open file descriptions, so concurrent in-process
    // updates on separate fds must serialize, not interleave.
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        journal.update((entries) => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          const next = [...entries, { ...CONCRETE, id: `whsub_serial_${i}` }];
          inside -= 1;
          return next;
        })
      )
    );
    expect(maxInside).toBe(1);
    await expect(journal.list()).resolves.toHaveLength(6);
  });

  it('waits for a lock held by ANOTHER PROCESS, then proceeds (kernel contention)', async () => {
    const dir = tmpJournalDir();
    const lock = path.join(dir, 'pending-cleanups.json.lock');
    const addon = require.resolve('fs-ext-extra-prebuilt');
    // The child takes the exclusive kernel lock, signals, holds ~700ms, then
    // releases by exiting normally.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const { flockSync } = require(process.env.ADDON); const fs = require('fs');
         const fd = fs.openSync(process.env.LOCK, 'a+');
         fs.writeSync(fd, 'agent-relay-cleanup-lock v2\\n', 0);
         flockSync(fd, 'ex');
         console.log('held');
         setTimeout(() => process.exit(0), 700);`,
      ],
      { env: { ...process.env, ADDON: addon, LOCK: lock }, stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('child never took the lock'));
      }, 5_000);
      const onData = (d: Buffer) => {
        if (String(d).includes('held')) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`child exited early: ${code}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout!.off('data', onData);
        child.off('exit', onExit);
      };
      child.stdout!.on('data', onData);
      child.on('exit', onExit);
    });

    const journal = fileCleanupJournal(dir);
    const started = Date.now();
    await journal.update(() => [CONCRETE]);
    // The update had to out-wait the live holder.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
  }, 20_000);

  it('recovers immediately when the holding process DIES without unlocking (crash release)', async () => {
    const dir = tmpJournalDir();
    const lock = path.join(dir, 'pending-cleanups.json.lock');
    const addon = require.resolve('fs-ext-extra-prebuilt');
    // The child takes the lock and hard-aborts WITHOUT flock('un') — the
    // kernel must release the lock with the process, unattended.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const { flockSync } = require(process.env.ADDON); const fs = require('fs');
         const fd = fs.openSync(process.env.LOCK, 'a+');
         fs.writeSync(fd, 'agent-relay-cleanup-lock v2\\n', 0);
         flockSync(fd, 'ex');
         console.log('held');
         process.abort();`,
      ],
      { env: { ...process.env, ADDON: addon, LOCK: lock }, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    await new Promise<void>((resolve) => {
      child.stdout!.on('data', (d) => String(d).includes('held') && resolve());
    });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    const journal = fileCleanupJournal(dir);
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
    expect(fs.existsSync(lock)).toBe(true); // stable file, never removed
  }, 20_000);

  it('fails closed on an unrecognized pre-release lock sentinel', async () => {
    const dir = tmpJournalDir();
    const lock = path.join(dir, 'pending-cleanups.json.lock');
    const sentinel = JSON.stringify({ pid: 1234, host: 'old-host' });
    fs.writeFileSync(lock, sentinel);

    const journal = fileCleanupJournal(dir);
    await expect(journal.update(() => [CONCRETE])).rejects.toMatchObject({ code: 'locked' });
    // The sentinel is preserved for inspection, not adopted or overwritten.
    expect(fs.readFileSync(lock, 'utf8')).toBe(sentinel);
  });

  it('heals a crash-truncated v2 marker (strict prefix) and proceeds', async () => {
    const dir = tmpJournalDir();
    const lock = path.join(dir, 'pending-cleanups.json.lock');
    fs.writeFileSync(lock, 'agent-relay-cleanup');

    const journal = fileCleanupJournal(dir);
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
    expect(fs.readFileSync(lock, 'utf8')).toBe('agent-relay-cleanup-lock v2\n');
  });
});
