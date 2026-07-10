import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CleanupJournalError,
  fileCleanupJournal,
  type PendingCleanupEntry,
} from './integration-cleanup-journal.js';

const CONCRETE: PendingCleanupEntry = {
  kind: 'relayfile-webhook-subscription',
  scope: 'relayfile:project-daemon',
  id: 'whsub_1',
};

const INTENT: PendingCleanupEntry = {
  kind: 'relayfile-webhook-subscription-intent',
  scope: 'relayfile:project-daemon',
  provider: 'slack',
  resource: '/slack/channels/C0/**',
  url: 'https://cast.test/inbound',
  pathGlobs: ['/slack/channels/C0/**'],
};

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
    // No temp/lock residue after a completed update.
    expect(fs.readdirSync(dir)).toEqual(['pending-cleanups.json']);

    await journal.update((entries) => entries.filter((e) => e.kind !== 'relayfile-webhook-subscription'));
    await expect(journal.list()).resolves.toEqual([INTENT]);
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
      [{ kind: 'relayfile-webhook-subscription-intent', scope: 's', url: 'u' }], // intent missing keys
      [
        {
          kind: 'relayfile-webhook-subscription-intent',
          scope: 's',
          url: 'u',
          provider: 'p',
          resource: 'r',
          pathGlobs: [],
        },
      ],
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

  it('takes over a stale lock only for a proven-dead same-host owner', async () => {
    const dir = tmpJournalDir();
    const lock = path.join(dir, 'pending-cleanups.json.lock');
    // A real pid that is guaranteed dead: a spawned child that already exited.
    const deadPid = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;
    fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, host: os.hostname() }));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, past, past);

    const journal = fileCleanupJournal(dir);
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
  });

  it('fails closed on a stale lock held by a live owner', async () => {
    const dir = tmpJournalDir();
    const lock = path.join(dir, 'pending-cleanups.json.lock');
    // This test process itself is the provably-alive owner.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, past, past);

    const journal = fileCleanupJournal(dir);
    await expect(journal.update(() => [CONCRETE])).rejects.toMatchObject({ code: 'locked' });
    // The foreign lock is never removed.
    expect(fs.existsSync(lock)).toBe(true);
  }, 15_000);

  it('fails closed on a stale lock from another host or with unreadable contents', async () => {
    for (const contents of [JSON.stringify({ pid: 1, host: 'some-other-host' }), 'garbage']) {
      const dir = tmpJournalDir();
      const lock = path.join(dir, 'pending-cleanups.json.lock');
      fs.writeFileSync(lock, contents);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, past, past);

      const journal = fileCleanupJournal(dir);
      await expect(
        journal.update(() => [CONCRETE]),
        contents
      ).rejects.toMatchObject({
        code: 'locked',
      });
      expect(fs.existsSync(lock)).toBe(true);
    }
  }, 30_000);
});
