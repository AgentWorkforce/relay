import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readTaskInput, MAX_INJECTION_BODY_BYTES } from './task-input.js';
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
    expect(await readTaskInput('a'.repeat(MAX_INJECTION_BODY_BYTES), undefined)).toHaveLength(
      MAX_INJECTION_BODY_BYTES
    );
    await expect(readTaskInput('é'.repeat(MAX_INJECTION_BODY_BYTES), undefined)).rejects.toThrow(
      'UTF-8 bytes'
    );
  });
});
