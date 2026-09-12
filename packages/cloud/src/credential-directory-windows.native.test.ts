import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertWindowsCredentialDirectory } from './credential-directory-windows.js';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
let directory: string | undefined;

afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describeWindows('native Windows credential directory ACL validation', () => {
  it('accepts a private temporary directory without changing its ACL', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-acl-native-'));
    expect(() => assertWindowsCredentialDirectory(directory!)).not.toThrow();
  });

  it('rejects an untrusted read grant on the credential directory itself', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-acl-native-unsafe-'));
    execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(R)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(() => assertWindowsCredentialDirectory(directory!)).toThrow(
      'Windows Relaycast credential storage requires a private directory'
    );
  });
});
