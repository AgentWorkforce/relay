import assert from 'node:assert/strict';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runBoundedProcess } from '../../../../scripts/pr-proof/process-runner.mjs';

export const CASE_PATH = 'tests/relayflows/cases/2100-copilot-native-mcp-route';
const TARGET_INPUTS = ['crates/relay-node', 'rust-toolchain', 'rust-toolchain.toml'];
const HARNESS_INPUTS = [CASE_PATH, 'scripts/pr-proof/process-runner.mjs'];

/** Keep provider credentials, loaders and Relay overrides out of every child. */
export function childEnv() {
  return {
    ...Object.fromEntries(
      [
        'PATH',
        'HOME',
        'CARGO_HOME',
        'RUSTUP_HOME',
        'TMPDIR',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'SystemRoot',
        'WINDIR',
      ]
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]])
    ),
    // Reading proof provenance must not refresh/write a checkout's index.
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** Reuse the trusted wrapper's bounded process-group termination, including Cargo descendants. */
export async function run(command, args, options = {}) {
  const result = await runBoundedProcess(command, args, {
    env: childEnv(),
    echo: false,
    maxCaptureBytes: 2 * 1024 * 1024,
    ...options,
  });
  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    throw new Error(
      `Proof subprocess failed (${command}, status ${result.exitCode}, signal ${result.signal}, timedOut ${result.timedOut}, aborted ${result.aborted}):\n${result.stderr.slice(-6000)}`
    );
  }
  return result.stdout;
}

export async function gitSha(directory) {
  return (await run('git', ['-C', directory, 'rev-parse', 'HEAD'], { timeoutMs: 10_000 })).trim();
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

/** Resolve existing symlink ancestors without creating the requested destination. */
async function prospectiveRealpath(candidate, remainingLinks = 40) {
  assert(remainingLinks > 0, 'Too many output-directory symlinks.');
  let ancestor = candidate;
  const suffix = [];
  for (;;) {
    try {
      return path.join(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const entry = await lstat(ancestor).catch((failure) => {
        if (failure.code !== 'ENOENT') throw failure;
        return null;
      });
      if (entry?.isSymbolicLink())
        return prospectiveRealpath(
          path.resolve(path.dirname(ancestor), await readlink(ancestor), ...suffix),
          remainingLinks - 1
        );
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Fail before mkdir/Cargo when output is lexically or physically inside either checkout. */
export async function externalPath(value, roots, label = 'Cargo target') {
  const candidate = path.resolve(value);
  assert(
    !roots.some((root) => inside(root, candidate)),
    `${label} must be outside target and harness checkouts.`
  );
  const canonical = await prospectiveRealpath(candidate);
  assert(
    !roots.some((root) => inside(root, canonical)),
    `${label} symlink resolves inside a protected checkout.`
  );
  return canonical;
}

/** Check only consumed inputs, leaving the wrapper's staged .relayflow input untouched. */
export async function assertProofInputs({ target, harness, targetSha, headSha }, phase) {
  for (const [label, directory, expected, inputs] of [
    ['Target', target, targetSha, TARGET_INPUTS],
    ['Harness', harness, headSha, HARNESS_INPUTS],
  ]) {
    assert.equal(await gitSha(directory), expected, `${label} SHA mismatch (${phase}).`);
    const status = await run(
      'git',
      ['-C', directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...inputs],
      {
        timeoutMs: 10_000,
      }
    );
    assert.equal(status, '', `${label} consumed inputs are dirty (${phase}).`);
    const ignored = await run(
      'git',
      [
        '-C',
        directory,
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ...inputs,
        ':(exclude)crates/relay-node/target',
      ],
      {
        timeoutMs: 10_000,
      }
    );
    assert.equal(ignored, '', `${label} has ignored/untracked consumed inputs (${phase}).`);
  }
}
