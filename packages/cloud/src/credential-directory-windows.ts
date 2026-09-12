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
  $leaf = [IO.DirectoryInfo]::new($leafPath)
  if (-not $leaf.Exists) {
    Emit-Failure 'credential-parent-not-directory'
    exit 0
  }

  $trustedSids = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [void]$trustedSids.Add([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  [void]$trustedSids.Add('S-1-5-18')
  [void]$trustedSids.Add('S-1-5-32-544')
  try {
    $trustedInstallerSid = ([Security.Principal.NTAccount]::new('NT SERVICE', 'TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value
    [void]$trustedSids.Add($trustedInstallerSid)
  } catch {
    # TrustedInstaller is optional; SYSTEM and Administrators remain trusted.
  }

  function Resolve-IdentitySid([object]$Reference, [string]$OwnerSid) {
    $value = if ($null -eq $Reference) {
      ''
    } elseif ($Reference -is [string]) {
      [string]$Reference
    } elseif ($null -ne $Reference.PSObject.Properties['Value']) {
      [string]$Reference.Value
    } else {
      [string]$Reference
    }
    if (-not $value) { return $null }
    try {
      $sid = $null
      if ($value -match '^S-\d-(?:\d+-){1,}\d+$') {
        $sid = ([Security.Principal.SecurityIdentifier]::new($value)).Value
      } else {
        $sid = ([Security.Principal.NTAccount]::new($value)).Translate([Security.Principal.SecurityIdentifier]).Value
      }
      # ACL enumeration commonly returns a localized NTAccount (for example,
      # "CREATOR OWNER") rather than the well-known SID directly. Resolve
      # first, then bind this inherited principal to the validated owner.
      if ($sid -eq 'S-1-3-0') { return $OwnerSid }
      return $sid
    } catch {
      return $null
    }
  }

  function Is-Trusted([string]$Sid) {
    return $null -ne $Sid -and $trustedSids.Contains($Sid)
  }

  $leafRiskMask = [int64][Security.AccessControl.FileSystemRights]::ReadData
  $leafRiskMask = $leafRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::WriteData
  $leafRiskMask = $leafRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::AppendData
  $leafRiskMask = $leafRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
  $leafRiskMask = $leafRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::Delete
  $leafRiskMask = $leafRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::ChangePermissions
  $leafRiskMask = $leafRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::TakeOwnership
  # Access rules can retain generic masks rather than their expanded file
  # rights. Normalize those high bits explicitly so they cannot bypass the
  # specific-rights checks above.
  $leafRiskMask = $leafRiskMask -bor [int64]268435456 # GENERIC_ALL
  $leafRiskMask = $leafRiskMask -bor [int64]2147483648 # GENERIC_READ
  $leafRiskMask = $leafRiskMask -bor [int64]1073741824 # GENERIC_WRITE

  # Directory WriteData is intentionally excluded: the credential directory's
  # existing owner must be protected from replacement, while ordinary parent
  # directories such as C:\Users may legitimately allow child creation.
  $ancestorRiskMask = [int64][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
  $ancestorRiskMask = $ancestorRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::Delete
  $ancestorRiskMask = $ancestorRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::ChangePermissions
  $ancestorRiskMask = $ancestorRiskMask -bor [int64][Security.AccessControl.FileSystemRights]::TakeOwnership
  $ancestorRiskMask = $ancestorRiskMask -bor [int64]268435456 # GENERIC_ALL

  $cursor = $leaf
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Emit-Failure 'credential-parent-reparse-point'
      exit 0
    }

    $acl = $cursor.GetAccessControl()
    $ownerSid = Resolve-IdentitySid $acl.Owner ''
    if (-not (Is-Trusted $ownerSid)) {
      Emit-Failure 'credential-parent-untrusted-owner'
      exit 0
    }

    $isLeaf = [StringComparer]::OrdinalIgnoreCase.Equals($cursor.FullName, $leaf.FullName)
    foreach ($entry in $acl.Access) {
      if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
        continue
      }
      # InheritOnly entries do not apply to this ancestor itself. On the leaf,
      # however, they govern future credential files and must still be checked.
      if (-not $isLeaf -and (($entry.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)) {
        continue
      }
      $principalSid = Resolve-IdentitySid $entry.IdentityReference $ownerSid
      if (Is-Trusted $principalSid) {
        continue
      }
      $rightsValue = ([int64]$entry.FileSystemRights -band 4294967295)
      $riskMask = if ($isLeaf) { $leafRiskMask } else { $ancestorRiskMask }
      if (($rightsValue -band $riskMask) -ne 0) {
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
        stdio: ['pipe', 'pipe', 'pipe'],
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
