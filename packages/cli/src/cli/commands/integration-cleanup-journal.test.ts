import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

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

const LEGACY_LOCK = 'pending-cleanups.json.lock';
const LEGACY_MARKER = 'agent-relay-cleanup-lock v2\n';

/** A pid that belonged to a process on this host that has exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '']).pid!;
}

/**
 * The lock protocol of the broker `journal-lock` helper that CLI releases up
 * to 17.2.1 spawn: flock(2) LOCK_EX|LOCK_NB on the `.lock` file, retried every
 * 100 ms until the timeout (exit 4); under the lock, anything that is not the
 * v2 marker or a prefix of it exits 3; then `locked`, stdin to EOF, and a
 * non-empty payload replaces the journal (temp + fsync + rename).
 */
const LEGACY_WRITER = String.raw`
import fcntl, os, sys, time
lock, journal, timeout_ms = sys.argv[1], sys.argv[2], int(sys.argv[3])
fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
deadline = time.monotonic() + timeout_ms / 1000
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.stderr.write('timeout\n')
            sys.exit(4)
        time.sleep(0.1)
marker = b'agent-relay-cleanup-lock v2\n'
content = os.pread(fd, 4096, 0)
if content != marker:
    if not marker.startswith(content):
        sys.stderr.write('sentinel\n')
        sys.exit(3)
    os.ftruncate(fd, 0)
    os.pwrite(fd, marker, 0)
    os.fsync(fd)
sys.stdout.write('locked\n')
sys.stdout.flush()
payload = sys.stdin.buffer.read()
if payload:
    tmp = journal + '.tmp-legacy'
    with open(tmp, 'wb') as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.rename(tmp, journal)
os.close(fd)
`;

function legacyWriterAvailable(): boolean {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return false;
  try {
    execFileSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface LegacyWriter {
  child: ChildProcess;
  /** True once it holds the lock; false if it exited without taking it. */
  locked: Promise<boolean>;
  exit: Promise<number | null>;
}

function startLegacyWriter(dir: string, timeoutMs: number): LegacyWriter {
  const child = spawn(
    'python3',
    [
      '-c',
      LEGACY_WRITER,
      path.join(dir, LEGACY_LOCK),
      path.join(dir, 'pending-cleanups.json'),
      String(timeoutMs),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const locked = new Promise<boolean>((resolve) => {
    child.stdout!.on('data', (d) => {
      if (String(d).includes('locked')) resolve(true);
    });
    void exit.then(() => resolve(false));
  });
  return { child, locked, exit };
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
    // No temp residue and no lock left behind after a completed update. The
    // legacy `.lock` file is a stable inode older CLIs lock; it stays.
    expect(fs.readdirSync(dir).sort()).toEqual(['pending-cleanups.json', LEGACY_LOCK]);

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
    expect(fs.readdirSync(dir).sort()).toEqual(['pending-cleanups.json', LEGACY_LOCK]);
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

  it('leaves an unrecognized legacy lock file untouched instead of failing closed on it', async () => {
    // The broker helper refused to run on a `.lock` file holding anything but
    // its v2 marker, so such a file already keeps older CLIs out: it is
    // neither rewritten nor a reason to fail.
    const dir = tmpJournalDir();
    const legacy = path.join(dir, 'pending-cleanups.json.lock');
    fs.writeFileSync(legacy, '{"pid":123,"host":"old"}');

    const journal = fileCleanupJournal(dir);
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
    expect(fs.readFileSync(legacy, 'utf8')).toBe('{"pid":123,"host":"old"}');
  });

  it('breaks an ownerless lock directory once it is older than the orphan window', async () => {
    // A crash between mkdir and writing owner.json leaves a lock with no owner.
    const dir = tmpJournalDir();
    const lockDir = path.join(dir, LOCK_DIR);
    fs.mkdirSync(lockDir);
    const past = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lockDir, past, past);

    const journal = fileCleanupJournal(dir);
    await journal.update(() => [CONCRETE]);
    await expect(journal.list()).resolves.toEqual([CONCRETE]);
    expect(fs.readdirSync(dir).sort()).toEqual(['pending-cleanups.json', LEGACY_LOCK]);
  });

  it('keeps a fresh ownerless lock directory and times out as `locked`', async () => {
    // The owner record may simply not be written yet.
    const dir = tmpJournalDir();
    fs.mkdirSync(path.join(dir, LOCK_DIR));

    const journal = fileCleanupJournal(dir);
    await expect(journal.update(() => [CONCRETE])).rejects.toMatchObject({ code: 'locked' });
    expect(fs.existsSync(path.join(dir, LOCK_DIR))).toBe(true);
  }, 20_000);

  it('needs no helper binary: works with no broker on disk, PATH or in the env', async () => {
    // A fresh standalone install has no agent-relay-broker anywhere. Point
    // every former resolver input at nothing and keep PATH empty.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-journal-nobin-'));
    const saved = {
      PATH: process.env.PATH,
      BROKER_BINARY_PATH: process.env.BROKER_BINARY_PATH,
      AGENT_RELAY_BIN: process.env.AGENT_RELAY_BIN,
    };
    process.env.PATH = empty;
    process.env.BROKER_BINARY_PATH = path.join(empty, 'agent-relay-broker');
    process.env.AGENT_RELAY_BIN = path.join(empty, 'agent-relay-broker');
    try {
      const dir = tmpJournalDir();
      const journal = fileCleanupJournal(dir);
      await journal.update(() => [CONCRETE, INTENT]);
      await expect(journal.list()).resolves.toEqual([CONCRETE, INTENT]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    // And the module no longer reaches for a child process or the broker
    // resolver at all.
    const source = fs.readFileSync(path.join(__dirname, 'integration-cleanup-journal.ts'), 'utf8');
    expect(source).not.toMatch(/from 'node:child_process'/);
    expect(source).not.toMatch(/harness-driver/);
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

  it('ends with an I/O error, not a spin, when the data directory refuses lock recovery', async () => {
    // Root ignores the mode bits, and Windows has no equivalent of them here.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const dir = tmpJournalDir();
    const lockDir = path.join(dir, LOCK_DIR);
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: deadPid(), host: os.hostname(), token: 'crashed' })
    );
    // The abandoned lock can be seen but not moved: renames and creates in
    // the data directory are refused.
    fs.chmodSync(dir, 0o500);
    // A loop that retries the refused recovery at once never yields to the
    // event loop, so no test timeout could stop it. After many attempts,
    // allow renames again: such an implementation then ends (and fails the
    // assertions below) instead of hanging the run.
    const realMkdir = fs.mkdirSync;
    let attempts = 0;
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((
      target: Parameters<typeof fs.mkdirSync>[0],
      options?: Parameters<typeof fs.mkdirSync>[1]
    ) => {
      if (target === lockDir && ++attempts === 10_000) fs.chmodSync(dir, 0o700);
      return realMkdir(target, options);
    }) as typeof fs.mkdirSync);
    let error: unknown;
    const started = Date.now();
    try {
      await fileCleanupJournal(dir).update(() => [CONCRETE]);
    } catch (err) {
      error = err;
    } finally {
      mkdirSpy.mockRestore();
      fs.chmodSync(dir, 0o700);
    }
    expect(error).toBeInstanceOf(CleanupJournalError);
    expect(error).toMatchObject({ code: 'io' });
    // Well within the 5 s lock deadline, after a handful of attempts.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(attempts).toBeLessThan(100);
    expect(JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).token).toBe('crashed');
    expect(fs.existsSync(path.join(dir, 'pending-cleanups.json'))).toBe(false);
  }, 20_000);

  describe.runIf(legacyWriterAvailable())(
    'with an older CLI (17.2.1 and earlier) on the same journal',
    () => {
      it('waits while an older CLI holds its lock, then builds on its commit', async () => {
        const dir = tmpJournalDir();
        const writer = startLegacyWriter(dir, 5_000);
        expect(await writer.locked).toBe(true);

        const journal = fileCleanupJournal(dir);
        let mutatedAt = 0;
        const update = journal.update((entries) => {
          mutatedAt = Date.now();
          return [...entries, INTENT];
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(mutatedAt).toBe(0);
        expect(fs.existsSync(path.join(dir, 'pending-cleanups.json'))).toBe(false);

        // The older CLI commits its own record and exits, releasing its lock.
        const releasedAt = Date.now();
        writer.child.stdin!.end(`${JSON.stringify([CONCRETE])}\n`);
        expect(await writer.exit).toBe(0);
        await update;
        expect(mutatedAt).toBeGreaterThanOrEqual(releasedAt);
        // Neither record was lost.
        await expect(journal.list()).resolves.toEqual([CONCRETE, INTENT]);
        expect(fs.readFileSync(path.join(dir, LEGACY_LOCK), 'utf8')).toBe(LEGACY_MARKER);
      }, 20_000);

      it('keeps an older CLI out of the journal while a transaction is open, and lets it in afterwards', async () => {
        const dir = tmpJournalDir();
        const journalPath = path.join(dir, 'pending-cleanups.json');
        fs.writeFileSync(journalPath, '[]\n');
        const journal = fileCleanupJournal(dir);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        const update = journal.update(async (entries) => {
          entered();
          await gate;
          return [...entries, INTENT];
        });
        await inside;

        // An older CLI either waits out its 5 s timeout (exit 4, macOS) or
        // refuses the file at once (exit 3, Linux); both report "locked" and
        // neither touches the journal.
        const blocked = startLegacyWriter(dir, 1_000);
        expect(await blocked.locked).toBe(false);
        expect([3, 4]).toContain(await blocked.exit);
        expect(fs.readFileSync(journalPath, 'utf8')).toBe('[]\n');

        release();
        await update;
        await expect(journal.list()).resolves.toEqual([INTENT]);

        const after = startLegacyWriter(dir, 1_000);
        expect(await after.locked).toBe(true);
        after.child.stdin!.end();
        expect(await after.exit).toBe(0);
        expect(fs.readFileSync(path.join(dir, LEGACY_LOCK), 'utf8')).toBe(LEGACY_MARKER);
      }, 20_000);
    }
  );

  it('never moves a fresh lock taken after a stale observation', async () => {
    const dir = tmpJournalDir();
    const lockDir = path.join(dir, LOCK_DIR);
    const ownerFile = path.join(lockDir, 'owner.json');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: deadPid(), host: os.hostname(), token: 'crashed' }));

    const fresh = fileCleanupJournal(dir);
    const late = fileCleanupJournal(dir);
    let releaseFresh!: () => void;
    const freshGate = new Promise<void>((resolve) => (releaseFresh = resolve));
    let freshUpdate: Promise<void> | undefined;
    let freshToken: string | undefined;
    const movedFresh: string[] = [];

    const realRead = fs.readFileSync;
    const realRename = fs.renameSync;
    const tokenAt = (): string | undefined => {
      try {
        return JSON.parse(String(realRead(ownerFile, 'utf8'))).token;
      } catch {
        return undefined;
      }
    };
    let triggered = false;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      file: Parameters<typeof fs.readFileSync>[0],
      options?: Parameters<typeof fs.readFileSync>[1]
    ) => {
      const result = realRead(file, options);
      if (file === ownerFile && !triggered) {
        triggered = true;
        // `late` has just observed the crashed owner. Before it acts, another
        // recoverer breaks that lock and a fresh writer takes it over.
        fs.rmSync(lockDir, { recursive: true, force: true });
        freshUpdate = fresh.update(async (entries) => {
          await freshGate;
          return [...entries, CONCRETE];
        });
        freshToken = tokenAt();
      }
      return result;
    }) as typeof fs.readFileSync);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((
      from: Parameters<typeof fs.renameSync>[0],
      to: Parameters<typeof fs.renameSync>[1]
    ) => {
      if (from === lockDir && freshToken !== undefined && tokenAt() === freshToken) {
        movedFresh.push(String(to));
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);

    try {
      const lateUpdate = late.update((entries) => [...entries, INTENT]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(freshToken).toBeDefined();
      expect(freshToken).not.toBe('crashed');
      // The stale observation moved nothing: the fresh lock and its owner are
      // exactly where the fresh writer put them.
      expect(movedFresh).toEqual([]);
      expect(tokenAt()).toBe(freshToken);

      releaseFresh();
      await freshUpdate;
      await lateUpdate;
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
      releaseFresh();
    }
    expect(movedFresh).toEqual([]);
    await expect(late.list()).resolves.toEqual([CONCRETE, INTENT]);
    expect(fs.readdirSync(dir).sort()).toEqual(['pending-cleanups.json', LEGACY_LOCK]);
  }, 20_000);
});
