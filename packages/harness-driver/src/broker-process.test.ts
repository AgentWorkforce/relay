import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProcessRunning, terminateFailedBrokerSpawn, waitForExit } from './broker-process.js';
import { HarnessDriverClient } from './client.js';

/**
 * A child that never exits unless told to. `kill` is observed rather than
 * obeyed, which is the case that matters: a process wedged in an
 * uninterruptible wait does not die when SIGKILL is delivered.
 */
function stubChild(options: { dieOnKill?: boolean } = {}): ChildProcess & {
  killed: NodeJS.Signals[];
} {
  const emitter = new EventEmitter() as unknown as ChildProcess & { killed: NodeJS.Signals[] };
  Object.assign(emitter, {
    exitCode: null,
    signalCode: null,
    killed: [] as NodeJS.Signals[],
    kill(signal: NodeJS.Signals) {
      (emitter.killed as NodeJS.Signals[]).push(signal);
      if (options.dieOnKill) emitter.emit('exit', null, signal);
      return true;
    },
  });
  return emitter;
}

describe('waitForExit', () => {
  it('reports an exit it observed', async () => {
    const child = stubChild();

    const pending = waitForExit(child, 50);
    child.emit('exit', 0, null);

    await expect(pending).resolves.toBe(true);
  });

  it('reports a process that is already gone without signalling it again', async () => {
    const child = stubChild();
    Object.assign(child, { signalCode: 'SIGTERM' });

    await expect(waitForExit(child, 50)).resolves.toBe(true);
    expect(child.killed).toEqual([]);
  });

  it('escalates to SIGKILL and reports the exit once it lands', async () => {
    const child = stubChild({ dieOnKill: true });

    await expect(waitForExit(child, 5)).resolves.toBe(true);
    expect(child.killed).toEqual(['SIGKILL']);
  });

  it('does not claim an exit it never saw after SIGKILL', async () => {
    const child = stubChild();

    // Resolving as soon as the signal was sent reports an exit nobody
    // observed; the CLI uses that answer to decide a broker is gone and its
    // node claim may be released.
    await expect(waitForExit(child, 5, 20)).resolves.toBe(false);
    expect(child.killed).toEqual(['SIGKILL']);
  });

  it('stops listening once it has settled', async () => {
    const child = stubChild();
    const removeListener = vi.spyOn(child, 'removeListener');

    const pending = waitForExit(child, 50);
    child.emit('exit', 0, null);
    await pending;

    expect(removeListener).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(child.listenerCount('exit')).toBe(0);
  });
});

describe('terminateFailedBrokerSpawn', () => {
  it('stops a child whose startup failed and reports the observed exit', async () => {
    // A spawn that rejects returns no client, so nothing downstream can stop
    // this child or even learn its pid — while it may already be binding,
    // handshaking, or holding a node claim's inherited fence descriptor.
    const child = stubChild({ dieOnKill: true });

    await expect(terminateFailedBrokerSpawn(child, 50)).resolves.toBe(true);
    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const child = stubChild();
    setTimeout(() => child.emit('exit', null, 'SIGKILL'), 10);

    await expect(terminateFailedBrokerSpawn(child, 5)).resolves.toBe(true);
    expect(child.killed).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not claim an exit it never saw', async () => {
    // The answer callers act on: an unverified exit must not read as gone.
    const child = stubChild();

    await expect(terminateFailedBrokerSpawn(child, 5)).resolves.toBe(false);
  });

  it('signals nothing when the child has already exited', async () => {
    const child = stubChild();
    Object.assign(child, { exitCode: 1 });

    await expect(terminateFailedBrokerSpawn(child, 50)).resolves.toBe(true);
    expect(child.killed).toEqual([]);
  });
});

describe('HarnessDriverClient.spawn cleanup', () => {
  const spawnTmpRoots: string[] = [];

  afterEach(() => {
    for (const dir of spawnTmpRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A "broker" that never announces an API port, so startup can only time out. */
  function writeSilentBroker(): { binaryPath: string; cwd: string; pidFile: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'broker-spawn-cleanup-'));
    spawnTmpRoots.push(cwd);
    const pidFile = join(cwd, 'child.pid');
    const binaryPath = join(cwd, 'silent-broker.sh');
    // `exec` keeps the recorded pid: the process that has to be reaped is the
    // one this file names.
    writeFileSync(binaryPath, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 30\n`, {
      mode: 0o755,
    });
    return { binaryPath, cwd, pidFile };
  }

  it('reaps the broker child when startup never reports an API port', async () => {
    // The child exists the moment `spawn` forks, and a rejection returns no
    // client — so nothing downstream knows its pid or can stop it. In `node up`
    // it is also already holding the node claim's inherited fence descriptor.
    const { binaryPath, cwd, pidFile } = writeSilentBroker();

    await expect(HarnessDriverClient.spawn({ binaryPath, cwd, startupTimeoutMs: 200 })).rejects.toThrow(
      /did not report API port/
    );

    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    // Verified gone, not merely signalled: `waitForApiUrl` sends SIGTERM on
    // timeout without ever observing an exit.
    expect(isProcessRunning(pid)).toBe(false);
  }, 20_000);
});
