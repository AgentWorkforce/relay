import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertWindowsCredentialDirectory } from './credential-directory-windows.js';

const describeWindows = process.platform === 'win32' ? describe : describe.skip;
let directory: string | undefined;

// This diagnostic is test-only and deliberately emits resolved SIDs and
// numeric ACL facts, never paths, account names, or native error text.
const ACL_DIAGNOSTIC_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Resolve-Sid([object]$Reference) {
  $value = if ($null -eq $Reference) {
    ''
  } elseif ($Reference -is [string]) {
    [string]$Reference
  } elseif ($null -ne $Reference.PSObject.Properties['Value']) {
    [string]$Reference.Value
  } else {
    [string]$Reference
  }
  if (-not $value) { return 'unresolved' }
  try {
    if ($value -match '^S-\d-(?:\d+-){1,}\d+$') {
      return ([Security.Principal.SecurityIdentifier]::new($value)).Value
    }
    return ([Security.Principal.NTAccount]::new($value)).Translate([Security.Principal.SecurityIdentifier]).Value
  } catch {
    return 'unresolved'
  }
}
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$cursor = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath([string]$request.directory))
$null = $cursor.Exists
$depth = 0
$rows = @()
while ($null -ne $cursor) {
  $acl = $cursor.GetAccessControl()
  $entries = @($acl.Access | ForEach-Object {
    [pscustomobject]@{
      principalSid = Resolve-Sid $_.IdentityReference
      type = [string]$_.AccessControlType
      rights = [int64]$_.FileSystemRights
      inheritance = [string]$_.InheritanceFlags
      propagation = [string]$_.PropagationFlags
    }
  })
  $rows += [pscustomobject]@{
    depth = $depth
    ownerSid = Resolve-Sid $acl.Owner
    attributes = [string]$cursor.Attributes
    entries = $entries
  }
  $cursor = $cursor.Parent
  $depth++
}
ConvertTo-Json -InputObject @($rows) -Depth 8 -Compress
`;

type AclDiagnosticEntry = {
  principalSid?: unknown;
  type?: unknown;
  rights?: unknown;
  inheritance?: unknown;
  propagation?: unknown;
};

type AclDiagnosticRow = {
  depth?: unknown;
  ownerSid?: unknown;
  attributes?: unknown;
  entries?: AclDiagnosticEntry[];
};

function reportAclDiagnostic(directoryPath: string): void {
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ACL_DIAGNOSTIC_SCRIPT],
      {
        input: JSON.stringify({ directory: path.resolve(directoryPath) }),
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 128 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const parsed = JSON.parse(output) as AclDiagnosticRow | AclDiagnosticRow[];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const safeRows = rows.map((row) => ({
      depth: row.depth,
      ownerSid: row.ownerSid,
      attributes: row.attributes,
      entries: (row.entries ?? []).map((entry) => ({
        principalSid: entry.principalSid,
        type: entry.type,
        rights: entry.rights,
        inheritance: entry.inheritance,
        propagation: entry.propagation,
      })),
    }));
    console.error(`[Windows ACL diagnostic] ${JSON.stringify(safeRows)}`);
  } catch {
    console.error('[Windows ACL diagnostic] unavailable');
  }
}

afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describeWindows('native Windows credential directory ACL validation', () => {
  it('accepts a private directory under the user profile without changing its ACL', () => {
    directory = fs.mkdtempSync(path.join(os.homedir(), '.relay-acl-native-'));
    try {
      expect(() => assertWindowsCredentialDirectory(directory!)).not.toThrow();
    } catch (error) {
      reportAclDiagnostic(directory);
      throw error;
    }
  });

  it('diagnoses a hosted temporary directory if inherited ACLs are too broad', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-acl-native-temp-'));
    try {
      assertWindowsCredentialDirectory(directory);
    } catch (error) {
      reportAclDiagnostic(directory);
      expect(String(error)).toContain('Windows Relaycast credential storage requires a private directory');
    }
  });

  it('rejects an untrusted read grant on the credential directory itself', () => {
    directory = fs.mkdtempSync(path.join(os.homedir(), '.relay-acl-native-unsafe-'));
    expect(() => assertWindowsCredentialDirectory(directory!)).not.toThrow();
    execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(R)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(() => assertWindowsCredentialDirectory(directory!)).toThrow(
      'Windows Relaycast credential storage requires a private directory'
    );
  });

  it('rejects an untrusted generic-all grant on the credential directory itself', () => {
    directory = fs.mkdtempSync(path.join(os.homedir(), '.relay-acl-native-generic-unsafe-'));
    expect(() => assertWindowsCredentialDirectory(directory!)).not.toThrow();
    execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(GA)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(() => assertWindowsCredentialDirectory(directory!)).toThrow(
      'Windows Relaycast credential storage requires a private directory'
    );
  });
});
