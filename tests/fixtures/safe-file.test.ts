import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  overwriteRegularFileNoFollow,
  readRegularFileNoFollow,
} from '../../scripts/verify-features/safe-file.mjs';

const execFileAsync = promisify(execFile);

describe('safe qualification file access', () => {
  it('reads and overwrites the opened inode while refusing symlinks and unsafe metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-safe-file-'));
    try {
      const target = path.join(root, 'evidence.json');
      const link = path.join(root, 'evidence-link.json');
      await writeFile(target, '{"version":1}\n', { mode: 0o600 });
      await symlink(target, link);

      await expect(
        readRegularFileNoFollow(target, {
          label: 'evidence',
          maxBytes: 1024,
          privateMode: true,
          currentUserOwned: true,
        })
      ).resolves.toMatchObject({ mode: 0o600, size: 14 });
      await expect(readRegularFileNoFollow(link, { label: 'evidence' })).rejects.toThrow(
        /symbolic link|ELOOP/i
      );

      await chmod(target, 0o644);
      await expect(readRegularFileNoFollow(target, { label: 'evidence', privateMode: true })).rejects.toThrow(
        'private'
      );
      await chmod(target, 0o600);
      await expect(readRegularFileNoFollow(target, { label: 'evidence', maxBytes: 4 })).rejects.toThrow(
        'size'
      );

      await overwriteRegularFileNoFollow(target, '{"version":2}\n', {
        label: 'evidence',
        currentUserOwned: true,
      });
      expect(await readFile(target, 'utf8')).toBe('{"version":2}\n');
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
      await expect(overwriteRegularFileNoFollow(link, 'unsafe')).rejects.toThrow(/symbolic link|ELOOP/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO promptly instead of blocking on an attacker-controlled writer',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'relay-safe-fifo-'));
      try {
        const fifo = path.join(root, 'evidence.fifo');
        await execFileAsync('mkfifo', [fifo]);
        await expect(readRegularFileNoFollow(fifo, { label: 'evidence FIFO' })).rejects.toThrow(
          'regular file'
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    2_000
  );
});
