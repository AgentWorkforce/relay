/**
 * Git Remote Detection Utility
 *
 * Detects the git remote URL from a working directory and parses it
 * to extract the repository full name (owner/repo).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Parse a git remote URL to extract owner/repo format.
 *
 * Supports:
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo
 * - git://github.com/owner/repo.git
 */
export function parseGitRemoteUrl(url: string): string | null {
  if (!url) return null;

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  // HTTPS/Git format: https://github.com/owner/repo.git
  const httpsMatch = url.match(/(?:https?|git):\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  return null;
}

/**
 * Get the git remote URL from a directory.
 *
 * @param workingDirectory The directory to check for git remote
 * @param remoteName The remote name to use (default: 'origin')
 * @returns The remote URL or null if not found
 */
export function getGitRemoteUrl(workingDirectory: string, remoteName = 'origin'): string | null {
  try {
    // First check if it's a git repository
    const gitDir = path.join(workingDirectory, '.git');
    if (!fs.existsSync(gitDir)) {
      return null;
    }

    // Try to get the remote URL using git command
    const result = execSync(`git remote get-url ${remoteName}`, {
      cwd: workingDirectory,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return result.trim() || null;
  } catch {
    // Git command failed - try parsing .git/config directly
    try {
      const configPath = path.join(workingDirectory, '.git', 'config');
      if (!fs.existsSync(configPath)) {
        return null;
      }

      const config = fs.readFileSync(configPath, 'utf-8');

      // Parse git config to find remote URL
      const remoteSection = new RegExp(
        `\\[remote\\s+"${remoteName}"\\][^\\[]*url\\s*=\\s*([^\\n]+)`,
        'i'
      );
      const match = config.match(remoteSection);

      return match?.[1]?.trim() || null;
    } catch {
      return null;
    }
  }
}

/**
 * Get the repository full name (owner/repo) from a working directory.
 *
 * @param workingDirectory The directory to check
 * @returns The repo full name (e.g., "AgentWorkforce/relay") or null
 */
export function getRepoFullName(workingDirectory: string): string | null {
  const remoteUrl = getGitRemoteUrl(workingDirectory);
  if (!remoteUrl) {
    return null;
  }

  return parseGitRemoteUrl(remoteUrl);
}

/**
 * Find the git root directory from a given path.
 * Walks up the directory tree looking for .git folder.
 *
 * @param startPath The path to start searching from
 * @returns The git root directory or null if not in a git repo
 */
export function findGitRoot(startPath: string): string | null {
  let currentPath = path.resolve(startPath);
  const root = path.parse(currentPath).root;

  while (currentPath !== root) {
    if (fs.existsSync(path.join(currentPath, '.git'))) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }

  return null;
}

/**
 * Get repository full name, walking up to find git root if needed.
 *
 * @param workingDirectory The directory to start from
 * @returns The repo full name or null
 */
export function getRepoFullNameFromPath(workingDirectory: string): string | null {
  // First try the exact directory
  let repoName = getRepoFullName(workingDirectory);
  if (repoName) {
    return repoName;
  }

  // Walk up to find git root
  const gitRoot = findGitRoot(workingDirectory);
  if (gitRoot && gitRoot !== workingDirectory) {
    repoName = getRepoFullName(gitRoot);
  }

  return repoName;
}
