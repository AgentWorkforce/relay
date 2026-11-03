import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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

const LOCK_DIR = 'pending-cleanups.json.lock.d';
// Guaranteed to differ from the runner's own hostname.
const OTHER_HOST = `${os.hostname()}-other`;

/**
 * Hold the journal lock from ANOTHER process using the on-disk protocol
 * (lock directory + owner record), exactly as a concurrent CLI would. The
 * holder releases on stdin EOF and can be SIGKILLed to simulate a crash.
 */
function spawnHolder(dir: string): Promise<ChildProcess> {
  const script = `
const fs = require('fs');
const os = require('os');
const path = require('path');
const lock = process.argv[1];
fs.mkdirSync(lock, { mode: 0o700 });
fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'holder' }));
process.stdout.write('locked\\n');
process.stdin.on('data', () => undefined);
process.stdin.on('end', () => { fs.rmSync(lock, { recursive: true, force: true }); process.exit(0); });
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, path.join(dir, LOCK_DIR)], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const timer = setTimeout(() => reject(new Error('holder never took the lock')), 10_000);
    child.stdout!.on('data', (d) => {
      if (String(d).includes('locked')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`holder exited early: ${code}`));
    });
  });
}

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
    // No temp residue and no lock left behind after a completed update.
    expect(fs.readdirSync(dir)).toEqual(['pending-cleanups.json']);

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

  it('serializes same-process contenders, including async mutators', async () => {
    const dir = tmpJournalDir();
    const journal = fileCleanupJournal(dir);
    let inside = 0;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        journal.update(async (entries) => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((resolve) => setTimeout(resolve, 5));
          const next = [...entries, { ...CONCRETE, id: `whsub_serial_${i}` }];
          inside -= 1;
          return next;
        })
      )
    );
    expect(maxInside).toBe(1);
    await expect(journal.list()).resolves.toHaveLength(6);
  });

  it('waits for a lock held by ANOTHER PROCESS, then proceeds', async () => {
    const dir = tmpJournalDir();
    const holder = await spawnHolder(dir);
    // Release the holder (stdin EOF) after ~700ms of exclusive hold.
    setTimeout(() => holder.stdin!.end(), 700);

    const journal = fileCleanupJournal(dir);
    const started = Date.now();
    await journal.update(() => [CONCRETE]);
    // The update had to out-wait the live holder.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
  }, 20_000);

  it('times out as `locked` while another live process holds the lock', async () => {
    const dir = tmpJournalDir();
    const holder = await spawnHolder(dir);
    try {
      const journal = fileCleanupJournal(dir);
      await expect(journal.update(() => [CONCRETE])).rejects.toMatchObject({ code: 'locked' });
      await expect(journal.list()).resolves.toEqual([]);
    } finally {
      holder.stdin!.end();
      await new Promise<void>((resolve) => holder.on('exit', () => resolve()));
    }
  }, 20_000);

  it('recovers immediately when the holding process is SIGKILLed (crash release)', async () => {
    const dir = tmpJournalDir();
    const holder = await spawnHolder(dir);
    // Hard-kill WITHOUT any release protocol — the lock directory stays behind
    // and must be broken because its owner is provably gone.
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.on('exit', () => resolve()));
    expect(fs.existsSync(path.join(dir, LOCK_DIR))).toBe(true);

    const journal = fileCleanupJournal(dir);
    const started = Date.now();
    await journal.update(() => [CONCRETE]);
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
    expect(fs.readdirSync(dir)).toEqual(['pending-cleanups.json']);
  }, 20_000);

  it('does not break a live holder on this host whose heartbeat stalled', async () => {
    const dir = tmpJournalDir();
    const lockDir = path.join(dir, LOCK_DIR);
    fs.mkdirSync(lockDir);
    // A live pid (this process) on this host with a heartbeat minutes old: a
    // stalled writer keeps exclusive ownership through its commit.
    const ownerFile = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'stalled' }));
    const past = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(ownerFile, past, past);

    const journal = fileCleanupJournal(dir);
    await expect(journal.update(() => [CONCRETE])).rejects.toMatchObject({ code: 'locked' });
    expect(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token).toBe('stalled');
  }, 20_000);

  it('breaks a same-host lock whose pid was reused (heartbeat far older than any stall)', async () => {
    const dir = tmpJournalDir();
    const lockDir = path.join(dir, LOCK_DIR);
    fs.mkdirSync(lockDir);
    const ownerFile = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'reused' }));
    const past = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(ownerFile, past, past);

    const journal = fileCleanupJournal(dir);
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
  });

  it('breaks a lock from another host once its lease heartbeat expired', async () => {
    const dir = tmpJournalDir();
    const lockDir = path.join(dir, LOCK_DIR);
    fs.mkdirSync(lockDir);
    const ownerFile = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: 1, host: OTHER_HOST, token: 'remote' }));
    const past = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(ownerFile, past, past);

    const journal = fileCleanupJournal(dir);
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
  });

  it('keeps a lock from another host while its lease is fresh', async () => {
    const dir = tmpJournalDir();
    const lockDir = path.join(dir, LOCK_DIR);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 1, host: OTHER_HOST, token: 'remote' })
    );
    const journal = fileCleanupJournal(dir);
    await expect(journal.update(() => [CONCRETE])).rejects.toMatchObject({ code: 'locked' });
  }, 20_000);

  it('leaves a lock file from an older broker-helper release untouched', async () => {
    const dir = tmpJournalDir();
    const legacy = path.join(dir, 'pending-cleanups.json.lock');
    fs.writeFileSync(legacy, 'agent-relay-cleanup-lock v2\n');

    const journal = fileCleanupJournal(dir);
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('agent-relay-cleanup-lock v2\n');
  });

  it('refuses to commit after its lock was broken, leaving the journal intact', async () => {
    const dir = tmpJournalDir();
    const journalPath = path.join(dir, 'pending-cleanups.json');
    fs.writeFileSync(journalPath, '[]\n');
    const lockDir = path.join(dir, LOCK_DIR);

    const journal = fileCleanupJournal(dir);
    await expect(
      journal.update(async (entries) => {
        // Another contender judged this lease stale and took the lock over.
        fs.rmSync(lockDir, { recursive: true, force: true });
        fs.mkdirSync(lockDir);
        fs.writeFileSync(
          path.join(lockDir, 'owner.json'),
          JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'usurper' })
        );
        return [...entries, CONCRETE];
      })
    ).rejects.toMatchObject({ code: 'io' });
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('[]\n');
    // The usurper's lock is not removed by the loser.
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it('runs the CLI under Bun without loading any native addon (--version smoke)', async () => {
    // Release-style regression: the Bun standalone externalizes native
    // addons, so ANY static native import crashes it. Running the built CLI
    // entry under bun proves the journal (and its import graph) is
    // addon-free. Skipped when bun or the built dist is unavailable.
    let bun = '';
    try {
      bun = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], {
        encoding: 'utf8',
      })
        .split(/\r?\n/)[0]!
        .trim();
    } catch {
      return; // no bun on this machine — covered by the Standalone Smoke CI job
    }
    const entry = path.resolve(__dirname, '../../../dist/cli/index.js');
    if (!bun || !fs.existsSync(entry)) return;
    const output = execFileSync(bun, [entry, '--version'], { encoding: 'utf8', timeout: 30_000 });
    expect(output.trim().length).toBeGreaterThan(0);
  }, 40_000);

  it('releases the lock when serialization fails; the next update succeeds', async () => {
    const dir = tmpJournalDir();
    const journalPath = path.join(dir, 'pending-cleanups.json');
    fs.writeFileSync(journalPath, '[]\n');
    const journal = fileCleanupJournal(dir);

    // JSON.stringify throws on BigInt — the serialization failure must run
    // inside the abort-protected block, releasing the lock.
    await expect(
      journal.update((entries) => [...entries, { bad: 1n } as unknown as PendingCleanupEntry])
    ).rejects.toThrow(/BigInt/);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('[]\n');

    // If the lock had leaked, this second update would time out.
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
  });

  it('releases without writing when the mutator throws', async () => {
    const dir = tmpJournalDir();
    const journalPath = path.join(dir, 'pending-cleanups.json');
    fs.writeFileSync(journalPath, '[]\n');
    const journal = fileCleanupJournal(dir);
    await expect(
      journal.update(() => {
        throw new Error('mutator exploded');
      })
    ).rejects.toThrow('mutator exploded');
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('[]\n');
    expect(fs.existsSync(path.join(dir, LOCK_DIR))).toBe(false);
  });
});
