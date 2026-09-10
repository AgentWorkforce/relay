import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  hardenPrivateRegularFileNoFollow,
  overwriteRegularFileNoFollow,
  readRegularFileNoFollow,
} from '../../scripts/verify-features/safe-file.mjs';

const execFileAsync = promisify(execFile);

describe('safe qualification file access', () => {
  it('hardens downloaded metadata through one no-follow descriptor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-safe-mode-'));
    const target = path.join(root, 'downloaded.json');
    try {
      await writeFile(target, '{"ok":true}\n', { mode: 0o644 });
      await hardenPrivateRegularFileNoFollow(target, {
        label: 'downloaded candidate metadata',
      });
      const hardened = await readRegularFileNoFollow(target, {
        label: 'downloaded candidate metadata',
        privateMode: true,
        currentUserOwned: true,
      });
      expect(hardened.mode).toBe(0o600);
      expect(hardened.bytes.toString('utf8')).toBe('{"ok":true}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('will not harden a symlink or non-regular artifact entry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'relay-safe-mode-reject-'));
    const target = path.join(root, 'source.json');
    const link = path.join(root, 'link.json');
    try {
      await writeFile(target, '{}\n', { mode: 0o644 });
      await symlink(target, link);
      await expect(hardenPrivateRegularFileNoFollow(link, { label: 'artifact link' })).rejects.toThrow(
        /symbolic link/
      );
      await expect(hardenPrivateRegularFileNoFollow(root, { label: 'artifact directory' })).rejects.toThrow(
        /regular file/
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      const overwritten = await readRegularFileNoFollow(target, {
        label: 'evidence',
        privateMode: true,
        currentUserOwned: true,
      });
      expect(overwritten.bytes.toString('utf8')).toBe('{"version":2}\n');
      expect(overwritten.mode).toBe(0o600);
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
