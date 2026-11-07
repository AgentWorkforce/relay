import fs from 'node:fs';
import path from 'node:path';

import { CoreUntrustedError } from './errors.js';

/**
 * Refuse a socket whose directory another user could have planted it in: it
 * must be this user's, and writable by no one else (the core creates it 0700).
 * A symlinked directory passes only when both the link and its target are
 * this user's. Does nothing on Windows or where `process.getuid` is absent.
 * @param socket - The core's bridge socket path
 * @throws CoreUntrustedError with reason `directory`
 */
export function trustedSocketDirectory(socket: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const directory = path.dirname(socket);
  const entry = fs.lstatSync(directory);
  const target = fs.statSync(directory);
  const uid = process.getuid();
  if (entry.uid !== uid || target.uid !== uid || !target.isDirectory() || (target.mode & 0o022) !== 0) {
    throw new CoreUntrustedError(
      'directory',
      `${directory} must be a directory only you can write to; refusing the core socket in it.`
    );
  }
}

/**
 * Refuse a socket the core did not make for this user: the core binds it
 * 0600 and owned by the user it runs as. Node cannot read a Unix socket's
 * peer credentials, so the socket file's owner and mode stand in for them
 * (only its owner, or root, can make or chmod it in a directory only this
 * user can write to). Does nothing on Windows or where `process.getuid` is absent.
 * @param socket - The core's bridge socket path
 * @throws CoreUntrustedError with reason `socket`
 */
export function trustedSocketFile(socket: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const entry = fs.lstatSync(socket);
  if (!entry.isSocket() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) {
    throw new CoreUntrustedError(
      'socket',
      `${socket} must be a socket only you can use (owned by you, mode 0600); refusing to speak to it.`
    );
  }
}
