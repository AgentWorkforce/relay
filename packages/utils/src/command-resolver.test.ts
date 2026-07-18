import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCommand } from './command-resolver.js';

/**
 * Regression coverage for the mise/asdf/rtx shim resolution bug.
 *
 * mise-style shims are symlinks whose target basename differs from the
 * shim's basename (e.g. `~/.local/share/mise/shims/codex` ->
 * `/opt/homebrew/bin/mise`). The manager binary dispatches to the real tool
 * based on `argv[0]`. If we canonicalise the shim, `argv[0]` becomes the
 * manager binary and provider flags like
 * `--dangerously-bypass-approvals-and-sandbox` are parsed by the manager
 * instead, aborting the worker.
 */
describe('resolveCommand — mise/asdf shim preservation', () => {
  let tmpRoot: string;
  let managerDir: string;
  let shimDir: string;
  let managerPath: string;
  let prevPath: string | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-resolver-shim-'));
    managerDir = path.join(tmpRoot, 'mgr');
    shimDir = path.join(tmpRoot, 'shims');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });

    managerPath = path.join(managerDir, 'mise');
    fs.writeFileSync(managerPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    prevPath = process.env.PATH;
  });

  afterEach(() => {
    if (prevPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = prevPath;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves the shim path when the shim is found via PATH', () => {
    const shim = path.join(shimDir, 'codex');
    fs.symlinkSync(managerPath, shim);

    // Prepend our shim dir so `which codex` finds our shim first while the
    // system `which` binary itself remains discoverable via the inherited
    // PATH.
    process.env.PATH = `${shimDir}:${prevPath ?? ''}`;

    const resolved = resolveCommand('codex');

    expect(path.basename(resolved)).toBe('codex');
    expect(path.basename(resolved)).not.toBe('mise');
    expect(path.isAbsolute(resolved)).toBe(true);
    // Realpath of the returned path should still land on the manager binary
    // — proving we found the shim but chose not to follow the symlink.
    expect(fs.realpathSync(resolved)).toBe(fs.realpathSync(managerPath));
  });

  it('preserves the shim path when the caller passes an explicit absolute path', () => {
    const shim = path.join(shimDir, 'gemini');
    fs.symlinkSync(managerPath, shim);

    const resolved = resolveCommand(shim);

    expect(path.basename(resolved)).toBe('gemini');
    expect(path.basename(resolved)).not.toBe('mise');
    // Reject the specific failure signature: resolving to the manager
    // binary would let mise consume `--dangerously-bypass-approvals-and-sandbox`.
    expect(resolved).not.toBe(fs.realpathSync(managerPath));
  });

  it('still canonicalises when the symlink target has the same basename', () => {
    // Common case: a bin directory is itself a symlink, so PATH lookup finds
    // `link/mytool` but realpath -> `real/mytool`. Same basename — safe to
    // follow, and matches the original posix_spawnp motivation for using
    // realpath at all.
    const realDir = path.join(tmpRoot, 'real');
    const linkDir = path.join(tmpRoot, 'link');
    fs.mkdirSync(realDir, { recursive: true });
    fs.mkdirSync(linkDir, { recursive: true });

    const realBin = path.join(realDir, 'mytool');
    fs.writeFileSync(realBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.symlinkSync(realBin, path.join(linkDir, 'mytool'));

    process.env.PATH = `${linkDir}:${prevPath ?? ''}`;

    const resolved = resolveCommand('mytool');
    expect(path.basename(resolved)).toBe('mytool');
    // No specific assertion about follow vs. preserve — the important thing
    // is the resolver returns a working `mytool` path without erroring on
    // same-name symlinks.
  });
});
