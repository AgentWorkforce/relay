import { execFileSync, spawn } from 'node:child_process';
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

// The kernel-lock tests exercise the REAL broker `journal-lock` helper from
// THIS checkout's cargo build (never an older installed release, which lacks
// the subcommand); they are skipped when it hasn't been built. Locally:
// `cargo build -p agent-relay-broker` first. Rust-side unit coverage lives in
// crates/broker/src/cli/journal_lock.rs.
const repoRoot = path.resolve(__dirname, '../../../../..');
const builtHelper = ['debug', 'release']
  .map((profile) =>
    path.join(
      repoRoot,
      'target',
      profile,
      process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker'
    )
  )
  .find((candidate) => fs.existsSync(candidate));
const brokerBinary = builtHelper;
const itWithBroker = brokerBinary ? it : it.skip;

/**
 * Suite-default helper. With a checkout-local cargo build we pin BOTH
 * resolver env overrides (BROKER_BINARY_PATH outranks AGENT_RELAY_BIN) to it
 * so an ambient developer/CI setting — or the published optional broker
 * package, which predates `journal-lock --journal-file` — can never be
 * substituted. WITHOUT a build (plain `npm test` CI jobs have no cargo), the
 * non-kernel tests run against a faithful scripted fake implementing the
 * same protocol: mkdir-mutex exclusion, v2 marker/sentinel rules, `locked`
 * handshake, empty-payload abort, and payload commit via temp+rename. The
 * real kernel semantics (contention, SIGKILL release) stay gated behind
 * itWithBroker.
 */
const FAKE_HELPER_BODY = `const fs = require('fs');
const args = process.argv;
const lock = args[args.indexOf('--file') + 1];
const journal = args[args.indexOf('--journal-file') + 1];
const timeoutMs = Number(args[args.indexOf('--timeout-ms') + 1] || 5000);
const mutex = lock + '.fake-mutex';
const deadline = Date.now() + timeoutMs;
(function spin() {
  try {
    fs.mkdirSync(mutex);
  } catch {
    if (Date.now() >= deadline) {
      console.error('timeout');
      process.exit(4);
    }
    return setTimeout(spin, 25);
  }
  process.on('exit', () => {
    try {
      fs.rmdirSync(mutex);
    } catch {}
  });
  const MARKER = 'agent-relay-cleanup-lock v2\\n';
  try {
    const content = fs.existsSync(lock) ? fs.readFileSync(lock, 'utf8') : '';
    if (content === '') fs.writeFileSync(lock, MARKER, { mode: 0o600 });
    else if (content !== MARKER && !MARKER.startsWith(content)) {
      console.error('sentinel');
      process.exit(3);
    } else if (content !== MARKER) fs.writeFileSync(lock, MARKER);
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
  process.stdout.write('locked\\n');
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const payload = Buffer.concat(chunks);
    if (payload.length > 0) {
      const tmp = journal + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      fs.renameSync(tmp, journal);
    }
    process.exit(0);
  });
})();
`;

function writeSuiteFakeHelper(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-fake-helper-'));
  const script = path.join(dir, 'fake-broker.cjs');
  fs.writeFileSync(script, `#!/usr/bin/env node\n${FAKE_HELPER_BODY}`, { mode: 0o755 });
  return script;
}

const suiteHelper = brokerBinary ?? writeSuiteFakeHelper();
process.env.BROKER_BINARY_PATH = suiteHelper;
process.env.AGENT_RELAY_BIN = suiteHelper;

/** Spawn the real helper as an external holder; resolves once it holds. */
function spawnHolder(lockFile: string): Promise<import('node:child_process').ChildProcess> {
  const child = spawn(
    brokerBinary!,
    [
      'journal-lock',
      '--file',
      lockFile,
      '--journal-file',
      `${lockFile}.journal-scratch`,
      '--timeout-ms',
      '5000',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  return new Promise((resolve, reject) => {
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

  itWithBroker(
    'waits for a lock held by ANOTHER PROCESS, then proceeds (kernel contention)',
    async () => {
      const dir = tmpJournalDir();
      const lock = path.join(dir, 'pending-cleanups.json.lock');
      const holder = await spawnHolder(lock);
      // Release the holder (stdin EOF) after ~700ms of exclusive hold.
      setTimeout(() => holder.stdin!.end(), 700);

      const journal = fileCleanupJournal(dir);
      const started = Date.now();
      await journal.update(() => [CONCRETE]);
      // The update had to out-wait the live holder.
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      await expect(journal.list()).resolves.toEqual([CONCRETE]);
    },
    20_000
  );

  itWithBroker(
    'recovers immediately when the holding process is SIGKILLed (crash release)',
    async () => {
      const dir = tmpJournalDir();
      const lock = path.join(dir, 'pending-cleanups.json.lock');
      const holder = await spawnHolder(lock);
      // Hard-kill WITHOUT any release protocol — the kernel must drop the lock
      // with the process, unattended.
      holder.kill('SIGKILL');
      await new Promise<void>((resolve) => holder.on('exit', () => resolve()));

      const journal = fileCleanupJournal(dir);
      await journal.update(() => [CONCRETE]);
      await expect(journal.list()).resolves.toEqual([CONCRETE]);
      expect(fs.existsSync(lock)).toBe(true); // stable file, never removed
    },
    20_000
  );

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
  /** Write an executable fake helper script and pin the resolver to it for
   * one test; returns a restore function. */
  function installFakeHelper(dir: string, body: string): () => void {
    const script = path.join(dir, 'fake-broker.cjs');
    fs.writeFileSync(script, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
    const previous = {
      broker: process.env.BROKER_BINARY_PATH,
      bin: process.env.AGENT_RELAY_BIN,
    };
    process.env.BROKER_BINARY_PATH = script;
    process.env.AGENT_RELAY_BIN = script;
    void previous;
    return () => {
      // Restore the suite default (real build when present, else the
      // faithful suite fake) — never an ambient/published binary.
      process.env.BROKER_BINARY_PATH = suiteHelper;
      process.env.AGENT_RELAY_BIN = suiteHelper;
    };
  }

  it('accepts a SPLIT locked handshake via exact buffered line parsing', async () => {
    const dir = tmpJournalDir();
    // Emits 'loc' and 'ked\n' as separate chunks, then commits stdin to the
    // journal file like the real helper.
    const restore = installFakeHelper(
      dir,
      `const fs = require('fs');
       const journal = process.argv[process.argv.indexOf('--journal-file') + 1];
       process.stdout.write('loc');
       setTimeout(() => {
         process.stdout.write('ked\\n');
         const chunks = [];
         process.stdin.on('data', (c) => chunks.push(c));
         process.stdin.on('end', () => {
           const payload = Buffer.concat(chunks);
           if (payload.length > 0) fs.writeFileSync(journal, payload);
           process.exit(0);
         });
       }, 50);`
    );
    try {
      const journal = fileCleanupJournal(dir);
      await journal.update(() => [CONCRETE]);
      await expect(journal.list()).resolves.toEqual([CONCRETE]);
    } finally {
      restore();
    }
  });

  it('kills and rejects on an INVALID handshake line, leaving the journal unmodified', async () => {
    const dir = tmpJournalDir();
    const journalPath = path.join(dir, 'pending-cleanups.json');
    fs.writeFileSync(journalPath, '[]\n');
    const restore = installFakeHelper(
      dir,
      `process.stdout.write('imposter\\n');
       setTimeout(() => process.exit(0), 5000);`
    );
    try {
      const journal = fileCleanupJournal(dir);
      await expect(journal.update(() => [CONCRETE])).rejects.toMatchObject({ code: 'io' });
      expect(fs.readFileSync(journalPath, 'utf8')).toBe('[]\n');
    } finally {
      restore();
    }
  });

  it('aborts without committing when the helper dies during an async mutator', async () => {
    const dir = tmpJournalDir();
    const journalPath = path.join(dir, 'pending-cleanups.json');
    fs.writeFileSync(journalPath, '[]\n');
    // Handshakes correctly, then dies shortly after — while the parent's
    // async mutator is still running.
    const restore = installFakeHelper(
      dir,
      `process.stdout.write('locked\\n');
       setTimeout(() => process.exit(1), 100);`
    );
    try {
      const journal = fileCleanupJournal(dir);
      await expect(
        journal.update(async (entries) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return [...entries, CONCRETE];
        })
      ).rejects.toMatchObject({ code: 'io' });
      // The lock (and isolation) died with the helper — the journal must be
      // byte-for-byte unmodified.
      expect(fs.readFileSync(journalPath, 'utf8')).toBe('[]\n');
    } finally {
      restore();
    }
  });

  it('fails the commit cleanly when the helper dies mid-write (EPIPE race), journal intact', async () => {
    const dir = tmpJournalDir();
    const journalPath = path.join(dir, 'pending-cleanups.json');
    fs.writeFileSync(journalPath, '[]\n');
    // Handshakes, then destroys its stdin and dies — the parent's
    // end(payload) races the exit and must surface a commit failure without
    // an unhandled EPIPE or a hung end callback.
    const restore = installFakeHelper(
      dir,
      `process.stdout.write('locked\\n');
       process.stdin.destroy();
       setTimeout(() => process.exit(1), 50);`
    );
    try {
      const journal = fileCleanupJournal(dir);
      await expect(journal.update((entries) => [...entries, CONCRETE])).rejects.toMatchObject({
        code: 'io',
      });
      expect(fs.readFileSync(journalPath, 'utf8')).toBe('[]\n');
    } finally {
      restore();
    }
  });

  it('releases without writing when the mutator throws (empty-payload abort)', async () => {
    const dir = tmpJournalDir();
    const journalPath = path.join(dir, 'pending-cleanups.json');
    fs.writeFileSync(journalPath, '[]\n');
    const restore = brokerBinary
      ? () => undefined
      : installFakeHelper(
          dir,
          `process.stdout.write('locked\\n');
       const chunks = [];
       process.stdin.on('data', (c) => chunks.push(c));
       process.stdin.on('end', () => process.exit(0));`
        );
    try {
      const journal = fileCleanupJournal(dir);
      await expect(
        journal.update(() => {
          throw new Error('mutator exploded');
        })
      ).rejects.toThrow('mutator exploded');
      expect(fs.readFileSync(journalPath, 'utf8')).toBe('[]\n');
    } finally {
      restore();
    }
  });
});
