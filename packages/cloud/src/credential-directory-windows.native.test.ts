import fs from 'node:fs';
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
});
