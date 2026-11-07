import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  let defaultSaveDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'relay-attachments-'));
    defaultSaveDir = path.resolve('.agent-relay', 'attachments', path.basename(dir));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(defaultSaveDir, { recursive: true, force: true });
  });

  it('reduces sender file names to one segment that also saves on Windows', () => {
    expect(safeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentFilename('what?*"<>|:.png')).toBe('what_______.png');
    expect(safeAttachmentFilename('report. . ')).toBe('report');
    expect(safeAttachmentFilename('CON.txt')).toBe('_CON.txt');
    expect(safeAttachmentFilename('lpt3')).toBe('_lpt3');
    expect(safeAttachmentFilename('console.log')).toBe('console.log');
    expect(safeAttachmentFilename(' .env')).toBe('env');
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

  it('uses a numbered name instead of replacing a default-path download', async () => {
    const fileId = path.basename(dir);
    const first = await saveAttachment(fileId, 'report.png', Buffer.from('first'));
    const second = await saveAttachment(fileId, 'report.png', Buffer.from('second'));

    expect(first).toBe(path.join(defaultSaveDir, 'report.png'));
    expect(second).toBe(path.join(defaultSaveDir, 'report (1).png'));
    expect(await readFile(first, 'utf8')).toBe('first');
    expect(await readFile(second, 'utf8')).toBe('second');
  });

  it.skipIf(process.platform === 'win32')('tightens an existing default directory to mode 0700', async () => {
    const fileId = path.basename(dir);
    await mkdir(defaultSaveDir, { recursive: true });
    await chmod(defaultSaveDir, 0o755);

    await saveAttachment(fileId, 'report.png', Buffer.from('private'));

    expect((await stat(defaultSaveDir)).mode & 0o077).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow a planted symlink at the default download path',
    async () => {
      const fileId = path.basename(dir);
      const outside = path.join(dir, 'outside.png');
      await writeFile(outside, 'outside');
      await mkdir(defaultSaveDir, { recursive: true });
      await symlink(outside, path.join(defaultSaveDir, 'shot.png'));

      const saved = await saveAttachment(fileId, 'shot.png', Buffer.from('download'));

      expect(saved).toBe(path.join(defaultSaveDir, 'shot (1).png'));
      expect(await readFile(outside, 'utf8')).toBe('outside');
      expect(await readFile(saved, 'utf8')).toBe('download');
    }
  );

  it.skipIf(process.platform === 'win32')('rejects a symlinked default attachment directory', async () => {
    const fileId = path.basename(dir);
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await mkdir(path.dirname(defaultSaveDir), { recursive: true });
    await symlink(outside, defaultSaveDir);

    await expect(saveAttachment(fileId, 'shot.png', Buffer.from('download'))).rejects.toThrow(
      /contains a symlink/
    );
    await expect(readFile(path.join(outside, 'shot.png'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
