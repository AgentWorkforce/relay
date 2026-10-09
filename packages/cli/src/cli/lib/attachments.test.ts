import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES,
  decodeBase64Strict,
  safeAttachmentFilename,
  saveAttachment,
} from './attachments.js';

describe('attachment helpers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'relay-attachments-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reduces sender file names to one segment that also saves on Windows', () => {
    expect(safeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentFilename('what?*"<>|:.png')).toBe('what_______.png');
    expect(safeAttachmentFilename('report. . ')).toBe('report');
    expect(safeAttachmentFilename('CON.txt')).toBe('_CON.txt');
    expect(safeAttachmentFilename('lpt3')).toBe('_lpt3');
    expect(safeAttachmentFilename('console.log')).toBe('console.log');
    expect(safeAttachmentFilename('...')).toBe('attachment');
  });

  it('decodes only strict base64 and refuses oversized input before decoding', () => {
    expect(decodeBase64Strict('aGVsbG8=')).toEqual(Buffer.from('hello'));
    expect(decodeBase64Strict('aGVs\nbG8=')).toEqual(Buffer.from('hello'));
    expect(() => decodeBase64Strict('aGV!bG8=')).toThrow(/not valid base64/);
    expect(decodeBase64Strict('aGVsbG8')).toEqual(Buffer.from('hello'));
    expect(() => decodeBase64Strict('aGVsbG8=x')).toThrow(/not valid base64/);
    expect(() => decodeBase64Strict('A'.repeat(32), 8)).toThrow(/exceeds the 8-byte limit/);
  });

  it('refuses to save an attachment over the size cap', async () => {
    await expect(
      saveAttachment('file-1', 'big.bin', new Uint8Array(MAX_ATTACHMENT_BYTES + 1), dir)
    ).rejects.toThrow(/exceeds/);
  });
});
