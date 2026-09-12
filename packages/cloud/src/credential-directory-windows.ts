import { execFileSync } from 'node:child_process';
import path from 'node:path';

const WINDOWS_ACL_TIMEOUT_MS = 5_000;

/**
 * This script is deliberately static. The directory is supplied as JSON on
 * stdin so a path can never become PowerShell source or an argument that is
 * reinterpreted by a shell.
 */
const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

function Emit-Failure([string]$Reason) {
  [Console]::Out.WriteLine((@{ ok = $false; reason = $Reason } | ConvertTo-Json -Compress))
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $leafPath = [IO.Path]::GetFullPath([string]$request.directory)
  $leaf = Get-Item -LiteralPath $leafPath -Force
  if (-not $leaf.PSIsContainer) {
    Emit-Failure 'credential-parent-not-directory'
    exit 0
  }

  $trusted = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [void]$trusted.Add([Security.Principal.WindowsIdentity]::GetCurrent().Name)
  [void]$trusted.Add('NT AUTHORITY\SYSTEM')
  [void]$trusted.Add('BUILTIN\Administrators')
  [void]$trusted.Add('NT SERVICE\TrustedInstaller')

  function Resolve-Principal([object]$Reference) {
    try {
      $sid = [Security.Principal.SecurityIdentifier]::new([string]$Reference.Value)
      return $sid.Translate([Security.Principal.NTAccount]).Value
    } catch {
      return [string]$Reference.Value
    }
  }

  function Is-Trusted([string]$Principal) {
    return $trusted.Contains($Principal)
  }

  function Has-LeafRisk([string]$Rights) {
    return $Rights -match 'Read|Write|WriteDac|WriteOwner|Delete|DeleteChild|ChangePermissions|TakeOwnership|FullControl|Modify'
  }

  function Has-AncestorReplacementRisk([string]$Rights) {
    return $Rights -match 'Write|WriteDac|WriteOwner|Delete|DeleteChild|ChangePermissions|TakeOwnership|FullControl|Modify'
  }

  $cursor = $leaf
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Emit-Failure 'credential-parent-reparse-point'
      exit 0
    }

    $acl = Get-Acl -LiteralPath $cursor.FullName
    if (-not (Is-Trusted (Resolve-Principal $acl.Owner))) {
      Emit-Failure 'credential-parent-untrusted-owner'
      exit 0
    }

    $isLeaf = $cursor.FullName -eq $leaf.FullName
    foreach ($entry in $acl.Access) {
      if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
        continue
      }
      $principal = Resolve-Principal $entry.IdentityReference
      if (Is-Trusted $principal) {
        continue
      }
      $rights = [string]$entry.FileSystemRights
      if (($isLeaf -and (Has-LeafRisk $rights)) -or ((-not $isLeaf) -and (Has-AncestorReplacementRisk $rights))) {
        Emit-Failure 'credential-parent-untrusted-allow'
        exit 0
      }
    }

    $cursor = $cursor.Parent
  }

  [Console]::Out.WriteLine('{"ok":true}')
} catch {
  Emit-Failure 'credential-parent-acl-unavailable'
}
`;

function privateDirectoryError(): Error {
  return new Error(
    'Windows Relaycast credential storage requires a private directory with trusted ACLs; choose a private directory under the current user profile.'
  );
}

/**
 * Verify the Windows ACL boundary before a plaintext credential store is
 * written. Non-Windows platforms retain their native permission checks.
 */
export function assertWindowsCredentialDirectory(directory: string): void {
  if (process.platform !== 'win32') return;

  const absoluteDirectory = path.resolve(directory);
  let output: string;
  try {
    output = execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_SCRIPT],
      {
        input: JSON.stringify({ directory: absoluteDirectory }),
        encoding: 'utf8',
        timeout: WINDOWS_ACL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      }
    );
  } catch {
    throw privateDirectoryError();
  }

  try {
    const result = JSON.parse(output) as { ok?: unknown };
    if (result.ok !== true) throw privateDirectoryError();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Windows Relaycast credential storage')) {
      throw error;
    }
    throw privateDirectoryError();
  }
}
