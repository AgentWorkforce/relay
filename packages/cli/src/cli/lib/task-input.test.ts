import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  readTaskInput,
  MAX_INJECTION_BODY_BYTES,
  MAX_TASK_BODY_BYTES,
  MUSE_STARTUP_PROMPT_MAX_BYTES,
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
      expect(await readTaskInput(between, undefined, false, cli)).toBe(between);
      await expect(
        readTaskInput('a'.repeat(MUSE_STARTUP_PROMPT_MAX_BYTES + 1), undefined, false, cli)
      ).rejects.toThrow('argv');
    }
    await expect(readTaskInput(between, undefined, false, 'musey')).rejects.toThrow('envelope');
    await expect(readTaskInput(between, undefined, false, 'claude')).rejects.toThrow('envelope');
  });
});
