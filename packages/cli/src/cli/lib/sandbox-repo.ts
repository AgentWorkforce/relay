import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { realpathSync } from 'node:fs';

const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface SandboxRepositorySelection {
  repository: string;
  repositoryName: string;
  revision: string;
  projectRoot: string;
  workerCwd: string;
}

export interface SandboxRepositoryDependencies {
  execFileSync?: typeof execFileSync;
  realpathSync?: typeof realpathSync;
  cwd?: () => string;
}

/**
 * Resolve the public repository identity and exact HEAD for a sandbox launch.
 * Only a GitHub-style owner/name and a 40-character commit are returned; local
 * paths never cross the Cloud request boundary.
 */
export function resolveSandboxRepository(
  projectRoot: string,
  requestedCwd: string | undefined,
  deps: SandboxRepositoryDependencies = {}
): SandboxRepositorySelection | undefined {
  const run = deps.execFileSync ?? execFileSync;
  const resolveRealpath = deps.realpathSync ?? realpathSync;
  const callerCwd = deps.cwd?.() ?? process.cwd();
  const remoteCwd =
    requestedCwd && /^\/(?:srv\/agent-workforce|workspace)(?:\/|$)/.test(requestedCwd)
      ? path.posix.normalize(requestedCwd)
      : undefined;
  if (remoteCwd && !/^\/(?:srv\/agent-workforce|workspace)(?:\/|$)/.test(remoteCwd)) {
    throw new Error('--cwd escapes the remote sandbox checkout roots.');
  }
  const invocationCwd = path.resolve(callerCwd, remoteCwd ? '.' : (requestedCwd ?? '.'));
  let gitRoot: string;
  try {
    gitRoot = run('git', ['-C', invocationCwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 10_000,
    })
      .trim()
      .replace(/[\\/]$/, '');
  } catch (error) {
    const failure = error as { status?: number; stderr?: string | Buffer };
    if (failure.status === 128 && failure.stderr?.toString().includes('not a git repository')) {
      // An explicitly selected Relay project can be outside the shell cwd.
      // Prefer the actual invocation repository, then honor that project root
      // only when Git confirms that the invocation itself is outside a repo.
      if (!requestedCwd && path.resolve(projectRoot) !== invocationCwd) {
        return resolveSandboxRepository(projectRoot, undefined, { ...deps, cwd: () => projectRoot });
      }
      return undefined;
    }
    throw new Error(
      'Cannot inspect the local Git checkout. Verify Git is installed and this repository is accessible, then retry.'
    );
  }
  if (!gitRoot) throw new Error('Git did not report a repository root; repair the checkout before retrying.');
  const root = path.resolve(gitRoot);
  // `git -C` follows symlinks while path.relative does not. Canonicalizing
  // both ends prevents a symlinked package invocation from becoming an
  // apparently outside checkout path (or from producing the wrong worker
  // subdirectory). Tests with synthetic paths retain the lexical fallback.
  const canonicalRoot = (() => {
    try {
      return resolveRealpath(root);
    } catch {
      return root;
    }
  })();
  const localCwd = (() => {
    const lexical = invocationCwd;
    try {
      return resolveRealpath(lexical);
    } catch {
      return lexical;
    }
  })();

  let remote: string;
  let revision: string;
  try {
    remote = run('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    throw new Error('Sandbox checkout has no usable origin remote; configure origin before retrying.');
  }
  try {
    revision = run('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
      .trim()
      .toLowerCase();
  } catch {
    throw new Error('Sandbox checkout has no committed HEAD; create or check out a commit before retrying.');
  }
  const repository = parseRepository(remote);
  if (!repository) {
    throw new Error('Sandbox checkout origin must be a GitHub owner/name repository.');
  }
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(
      'Sandbox checkout HEAD is not a complete commit SHA; check out a committed revision first.'
    );
  }

  let status: string;
  try {
    status = run('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
  } catch {
    throw new Error('Cannot verify that the Git checkout is clean. Repair the checkout and retry.');
  }
  const disallowed = status
    .split('\0')
    .filter(Boolean)
    .filter((entry) => {
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      return code !== '??' || !isGeneratedRelayMetadata(file);
    });
  if (disallowed.length > 0) {
    throw new Error(
      `Sandbox requires a clean checkout. Commit or stash local changes before retrying; changed path: ${JSON.stringify(disallowed[0].slice(3))}`
    );
  }

  let upstream: string | undefined;
  try {
    upstream = run('git', ['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    upstream = undefined;
  }
  if (upstream?.startsWith('origin/')) {
    try {
      run('git', ['-C', root, 'merge-base', '--is-ancestor', 'HEAD', upstream], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      });
    } catch {
      throw new Error(
        `Sandbox commit ${revision} is not pushed to ${upstream}. Push the exact commit before retrying.`
      );
    }
  }

  const relative = path.relative(canonicalRoot, localCwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      '--cwd is outside the checked-out repository; use a repository-relative cwd or an explicit remote sandbox path.'
    );
  }

  const repositoryName = repository.slice(repository.indexOf('/') + 1);
  const remoteRoot = `/srv/agent-workforce/${repositoryName}`;
  const relativePosix = relative.split(path.sep).filter(Boolean).join('/');
  return {
    repository,
    repositoryName,
    revision,
    projectRoot: canonicalRoot,
    workerCwd: remoteCwd ?? (relativePosix ? `${remoteRoot}/${relativePosix}` : remoteRoot),
  };
}

function isGeneratedRelayMetadata(entry: string): boolean {
  const normalized = entry.replaceAll('\\', '/');
  if (!normalized.startsWith('.agentworkforce/relay/')) return false;
  const relative = normalized.slice('.agentworkforce/relay/'.length);
  return (
    relative === 'workspace-key.json' ||
    relative === 'connection.json' ||
    relative === 'runtime.json' ||
    /^broker-[^/]+\.lock$/.test(relative)
  );
}

function parseRepository(remote: string): string | undefined {
  const value = remote.trim();
  let owner: string | undefined;
  let name: string | undefined;
  const scp = value.match(/^([^@/]+)@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (scp) {
    if (scp[2].toLowerCase() !== 'github.com') return undefined;
    owner = scp[3];
    name = scp[4];
  } else {
    try {
      const parsed = new URL(value);
      if (!['https:', 'ssh:'].includes(parsed.protocol)) return undefined;
      if (parsed.hostname.toLowerCase() !== 'github.com') return undefined;
      if (parsed.password || (parsed.username && !(parsed.protocol === 'ssh:' && parsed.username === 'git')))
        return undefined;
      if (parsed.search || parsed.hash || parsed.port) return undefined;
      const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length !== 2) return undefined;
      owner = parts[0];
      name = parts[1].replace(/\.git$/, '');
    } catch {
      return undefined;
    }
  }
  if (
    !owner ||
    !name ||
    !REPOSITORY_PART_PATTERN.test(owner) ||
    !REPOSITORY_PART_PATTERN.test(name) ||
    owner.includes('..') ||
    name.includes('..')
  )
    return undefined;
  return `${owner}/${name}`;
}
