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

// assertWindowsCredentialDirectory() shells out to a cold powershell.exe process
// and allows up to WINDOWS_ACL_TIMEOUT_MS (15_000ms) in credential-directory-windows.ts.
// Give these tests a per-test timeout comfortably above that so a cold PowerShell
// start doesn't trip vitest's default 5000ms timeout.
const WINDOWS_ACL_TEST_TIMEOUT_MS = 20_000;

describeWindows('native Windows credential directory ACL validation', () => {
  it(
    'accepts a private directory under the user profile without changing its ACL',
    () => {
      directory = fs.mkdtempSync(path.join(os.homedir(), '.relay-acl-native-'));
      expect(() => assertWindowsCredentialDirectory(directory!)).not.toThrow();
    },
    WINDOWS_ACL_TEST_TIMEOUT_MS
  );

  it(
    'rejects an untrusted read grant on the credential directory itself',
    () => {
      directory = fs.mkdtempSync(path.join(os.homedir(), '.relay-acl-native-unsafe-'));
      expect(() => assertWindowsCredentialDirectory(directory!)).not.toThrow();
      execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(R)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      expect(() => assertWindowsCredentialDirectory(directory!)).toThrow(
        'Windows Relaycast credential storage requires a private directory'
      );
    },
    WINDOWS_ACL_TEST_TIMEOUT_MS
  );

  it(
    'rejects an untrusted generic-all grant on the credential directory itself',
    () => {
      directory = fs.mkdtempSync(path.join(os.homedir(), '.relay-acl-native-generic-unsafe-'));
      expect(() => assertWindowsCredentialDirectory(directory!)).not.toThrow();
      execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(GA)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      expect(() => assertWindowsCredentialDirectory(directory!)).toThrow(
        'Windows Relaycast credential storage requires a private directory'
      );
    },
    WINDOWS_ACL_TEST_TIMEOUT_MS
  );
});
