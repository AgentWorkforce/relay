import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aiHistOptionalDepName, getAiHistBinaryPath } from './ai-hist-path.js';

describe('aiHistOptionalDepName', () => {
  it('maps platform/arch to the per-platform package name', () => {
    expect(aiHistOptionalDepName('darwin', 'arm64')).toBe('ai-hist-bin-darwin-arm64');
    expect(aiHistOptionalDepName('linux', 'x64')).toBe('ai-hist-bin-linux-x64');
  });
});

describe('getAiHistBinaryPath', () => {
  let tmp: string | undefined;
  const prev = process.env.AI_HIST_RUST_BIN;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aihist-bin-'));
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_HIST_RUST_BIN;
    else process.env.AI_HIST_RUST_BIN = prev;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('honors an existing $AI_HIST_RUST_BIN override', () => {
    const bin = join(tmp as string, 'ai-hist');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    process.env.AI_HIST_RUST_BIN = bin;
    expect(getAiHistBinaryPath()).toBe(bin);
  });

  it('ignores a non-existent override (never returns the bad path)', () => {
    const missing = join(tmp as string, 'does-not-exist');
    process.env.AI_HIST_RUST_BIN = missing;
    // Falls through to bundled package / install-path / the `ai-hist` command —
    // exact result is environment-dependent, but never the missing override.
    const resolved = getAiHistBinaryPath();
    expect(resolved).not.toBe(missing);
    expect(typeof resolved).toBe('string');
  });
});
