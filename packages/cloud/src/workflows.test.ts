import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, realpath, rm } from 'node:fs/promises';

import { relativizeWorkflowPath } from './workflows.js';

describe('relativizeWorkflowPath', () => {
  let tmpRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    // On macOS os.tmpdir() is a symlink (e.g. /var → /private/var), so
    // after chdir() process.cwd() returns the realpath. Resolve both up
    // front so assertions that build absolute paths relative to the
    // temp dir compare apples to apples.
    tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'relativize-workflow-')));
    process.chdir(tmpRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns a forward-slash relative path for a sibling of cwd', () => {
    const result = relativizeWorkflowPath('workflows/foo.ts');
    expect(result).toBe('workflows/foo.ts');
  });

  it('strips a leading ./', () => {
    const result = relativizeWorkflowPath('./workflows/foo.ts');
    expect(result).toBe('workflows/foo.ts');
  });

  it('relativizes an absolute path that lives inside cwd', () => {
    const abs = path.join(tmpRoot, 'nested', 'workflow.ts');
    const result = relativizeWorkflowPath(abs);
    expect(result).toBe('nested/workflow.ts');
  });

  it('returns null for an absolute path outside cwd', async () => {
    // realpath() so the comparison is symlink-stable on macOS (same
    // reason we realpath() tmpRoot above).
    const outsideDir = await realpath(os.tmpdir());
    const outside = path.resolve(outsideDir, 'not-in-cwd', 'workflow.ts');
    const result = relativizeWorkflowPath(outside);
    expect(result).toBeNull();
  });

  it('returns null for a path that escapes cwd via ..', () => {
    const result = relativizeWorkflowPath('../escaped.ts');
    expect(result).toBeNull();
  });

  it('returns null when the arg resolves to cwd itself', () => {
    const result = relativizeWorkflowPath('.');
    expect(result).toBeNull();
  });
});
