import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ancestors,
  argvOf,
  claudeStartMatches,
  claudeStartSeconds,
  holdsFile,
  isAlive,
  parentOf,
  processStart,
} from '../src/relay/processes.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function tempDir() {
  const dir = await mkdtemp(join(process.env.TMPDIR || os.tmpdir(), 'relay-proc-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('processes', () => {
  it('walks the current process up through its parent', async () => {
    const chain = await ancestors(process.pid);
    expect(chain[0].pid).toBe(process.pid);
    expect(chain.map((entry) => entry.pid)).toContain(process.ppid);
    expect(await parentOf(process.pid)).toBe(process.ppid);
    expect(chain.length).toBeLessThanOrEqual(64);
    expect(await ancestors(process.pid, 1)).toHaveLength(1);
  });

  it('reads a stable start time that matches itself as Claude would record it', async () => {
    const first = await processStart(process.pid);
    const second = await processStart(process.pid);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(claudeStartMatches(first, second)).toBe(true);
    if (process.platform === 'darwin') {
      expect(first).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    } else {
      expect(first).toMatch(/^\d+$/);
    }
  });

  it('compares macOS start strings to the second, and Linux ticks exactly', () => {
    expect(claudeStartSeconds('Wed Sep 30 10:00:00 2026')).toBe(Date.UTC(2026, 8, 30, 10, 0, 0) / 1000);
    expect(claudeStartSeconds('Mon Oct  5 01:02:03 2026')).toBe(Date.UTC(2026, 9, 5, 1, 2, 3) / 1000);
    expect(claudeStartSeconds('Mon Feb 31 01:02:03 2026')).toBeNull();
    expect(claudeStartSeconds('garbage')).toBeNull();
    expect(claudeStartMatches('Mon Oct  5 01:02:03 2026', 'Mon Oct 5 01:02:03 2026', 'darwin')).toBe(true);
    expect(claudeStartMatches('Mon Oct 5 01:02:04 2026', 'Mon Oct 5 01:02:03 2026', 'darwin')).toBe(false);
    expect(claudeStartMatches(' 12345 ', '12345', 'linux')).toBe(true);
    expect(claudeStartMatches('12346', '12345', 'linux')).toBe(false);
  });

  it('sees a file a child holds open, its arguments, and its death', async () => {
    const dir = await tempDir();
    const file = join(dir, 'held.lock');
    await writeFile(file, '');
    const child = spawn('/bin/sh', ['-c', 'exec sleep 30 3<"$0"', file], { stdio: 'ignore' });
    cleanups.push(() => {
      child.kill('SIGKILL');
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(child.pid!)).toBe(true);
    expect(await holdsFile(child.pid!, file)).toBe(true);
    expect(await holdsFile(child.pid!, join(dir, 'other.lock'))).toBe(false);
    expect(await argvOf(child.pid!)).toEqual(['sleep', '30']);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(child.pid!)).toBe(false);
    expect(await processStart(child.pid!)).toBeNull();
  });
});
