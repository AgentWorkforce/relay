import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  readTaskInput,
  MAX_INJECTION_BODY_BYTES,
  MAX_TASK_BODY_BYTES,
  MAX_ARGV_TASK_BYTES,
  MAX_NATIVE_TASK_BYTES,
} from './task-input.js';
describe('task input', () => {
  it('requires exactly one source for fleet, allows neither locally', async () => {
    await expect(readTaskInput(undefined, undefined, true)).rejects.toThrow('exactly one');
    await expect(readTaskInput('hi', 'brief.md')).rejects.toThrow('exactly one');
    expect(await readTaskInput(undefined, undefined)).toBeUndefined();
  });
  it('reads requester files without stripping whitespace or normalizing CRLF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-task-'));
    try {
      const file = join(dir, 'brief.md');
      await writeFile(file, '  héllo\r\nworld\n');
      expect(await readTaskInput(undefined, file, true)).toBe('  héllo\r\nworld\n');
      await writeFile(file, '  ');
      await expect(readTaskInput(undefined, file)).rejects.toThrow('empty');
      await expect(readTaskInput(undefined, join(dir, 'missing'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  // Only one byte past the limit is ever read, so an oversized or endless
  // --task-file fails cheaply instead of being materialized in memory.
  it.skipIf(process.platform === 'win32')(
    'reads at most one byte past the limit from a task file',
    async () => {
      await expect(readTaskInput(undefined, '/dev/zero')).rejects.toThrow('UTF-8 bytes');
      await expect(readTaskInput(undefined, '/dev/zero', false, { cli: 'muse' })).rejects.toThrow('argv');
    },
    2000
  );
  it('counts UTF-8 bytes', async () => {
    expect(await readTaskInput('a'.repeat(MAX_TASK_BODY_BYTES), undefined)).toHaveLength(MAX_TASK_BODY_BYTES);
    await expect(readTaskInput('é'.repeat(MAX_TASK_BODY_BYTES), undefined)).rejects.toThrow('UTF-8 bytes');
  });
  // The broker caps the formatted envelope at 16 KiB, so a body at that size
  // would launch a worker and only then fail; leave room for the envelope.
  it('rejects a body that only fits the PTY limit before its envelope is added', async () => {
    expect(MAX_TASK_BODY_BYTES).toBeLessThan(MAX_INJECTION_BODY_BYTES);
    await expect(readTaskInput('a'.repeat(MAX_INJECTION_BODY_BYTES), undefined)).rejects.toThrow('envelope');
    await expect(readTaskInput('a'.repeat(MAX_TASK_BODY_BYTES + 1), undefined)).rejects.toThrow(
      'UTF-8 bytes'
    );
  });
  // Muse takes its startup task as one argv entry, never through the PTY
  // envelope, so the broker's 16 KiB argv limit applies instead.
  it('applies the Muse argv limit, not the PTY body limit, to Muse tasks', async () => {
    const between = 'a'.repeat(MAX_TASK_BODY_BYTES + 1);
    for (const cli of ['muse', 'MUSE.exe', '/usr/local/bin/muse', 'C:\\Tools\\Muse.CMD']) {
      expect(await readTaskInput(between, undefined, false, { cli })).toBe(between);
      await expect(
        readTaskInput('a'.repeat(MAX_ARGV_TASK_BYTES + 1), undefined, false, { cli })
      ).rejects.toThrow('argv');
    }
    await expect(readTaskInput(between, undefined, false, { cli: 'musey' })).rejects.toThrow('envelope');
    await expect(readTaskInput(between, undefined, false, { cli: 'claude' })).rejects.toThrow('envelope');
  });
  // A native runtime receives its task as a delivery frame: neither the PTY
  // envelope nor the argv ceiling applies, only a bound on what is read.
  it('does not apply PTY or argv limits to native-runtime tasks', async () => {
    const overArgv = 'a'.repeat(MAX_ARGV_TASK_BYTES + 1);
    const native = { cli: 'claude', runtime: 'native' } as const;
    expect(await readTaskInput(overArgv, undefined, false, native)).toBe(overArgv);
    await expect(
      readTaskInput('a'.repeat(MAX_NATIVE_TASK_BYTES + 1), undefined, false, native)
    ).rejects.toThrow(`${MAX_NATIVE_TASK_BYTES} UTF-8 bytes`);
    const dir = await mkdtemp(join(tmpdir(), 'relay-task-'));
    try {
      const file = join(dir, 'brief.md');
      await writeFile(file, overArgv);
      expect(await readTaskInput(undefined, file, false, native)).toBe(overArgv);
      await expect(readTaskInput(undefined, file, false, { cli: 'claude', runtime: 'pty' })).rejects.toThrow(
        'envelope'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects a task file that is not valid UTF-8 instead of altering its text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relay-task-'));
    try {
      const file = join(dir, 'brief.md');
      await writeFile(file, Buffer.from([0x68, 0x69, 0xff, 0x0a]));
      await expect(readTaskInput(undefined, file)).rejects.toThrow('not valid UTF-8');
      // An oversized file whose cut lands inside a character is reported by
      // size, not as invalid UTF-8.
      await writeFile(file, 'é'.repeat(MAX_TASK_BODY_BYTES));
      await expect(readTaskInput(undefined, file)).rejects.toThrow('UTF-8 bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
