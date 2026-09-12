import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

import { assertWindowsCredentialDirectory } from './credential-directory-windows.js';

const execFileSyncMock = vi.mocked(execFileSync);
const originalPlatform = process.platform;

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});

function withWindowsPlatform(): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
}

describe('assertWindowsCredentialDirectory', () => {
  it('does not invoke PowerShell on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    assertWindowsCredentialDirectory('/tmp/relay-credentials');
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('passes the directory as JSON stdin to a static PowerShell probe', () => {
    withWindowsPlatform();
    execFileSyncMock.mockReturnValue('{"ok":true}');
    const directory = path.join(os.tmpdir(), 'relay-acl-private');

    expect(() => assertWindowsCredentialDirectory(directory)).not.toThrow();

    const [command, args, options] = execFileSyncMock.mock.calls[0]!;
    expect(command).toBe('powershell.exe');
    expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', expect.any(String)]);
    expect(options).toMatchObject({
      input: JSON.stringify({ directory: path.resolve(directory) }),
      encoding: 'utf8',
      timeout: expect.any(Number),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const script = String(args[args.length - 1]);
    expect(script).toContain('DirectoryInfo]::new');
    expect(script).toContain('GetAccessControl');
    expect(script).not.toContain('Get-Acl');
    expect(script).toContain('ReparsePoint');
    expect(script).toContain('S-1-5-18');
    expect(script).toContain('ReadData');
    expect(script).toContain('DeleteSubdirectoriesAndFiles');
    expect(script).toContain('InheritOnly');
    expect(script).not.toContain('$acl.Owner.Value');
    expect(script).not.toContain(directory);
    expect(args).not.toContain(path.resolve(directory));
    expect(args).not.toContain('-ExecutionPolicy');
  });

  it('fails closed without exposing native ACL output or the path', () => {
    withWindowsPlatform();
    execFileSyncMock.mockReturnValue(
      '{"ok":false,"reason":"credential-parent-untrusted-allow","detail":"secret-token"}'
    );
    const directory = path.join(os.tmpdir(), 'relay-acl-secret-path');

    expect(() => assertWindowsCredentialDirectory(directory)).toThrow(
      'Windows Relaycast credential storage requires a private directory'
    );
    try {
      assertWindowsCredentialDirectory(directory);
    } catch (error) {
      expect(String(error)).not.toContain('secret-token');
      expect(String(error)).not.toContain(directory);
    }
  });

  it('fails closed when PowerShell is unavailable or times out', () => {
    withWindowsPlatform();
    execFileSyncMock.mockImplementation(() => {
      throw new Error('powershell output contained a credential');
    });

    expect(() => assertWindowsCredentialDirectory('/tmp/relay-acl-private')).toThrow(
      'choose a private directory under the current user profile'
    );
  });
});
