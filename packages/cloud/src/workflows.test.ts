import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.equal(result, 'workflows/foo.ts');
  });

  it('strips a leading ./', () => {
    const result = relativizeWorkflowPath('./workflows/foo.ts');
    assert.equal(result, 'workflows/foo.ts');
  });

  it('relativizes an absolute path that lives inside cwd', () => {
    const abs = path.join(tmpRoot, 'nested', 'workflow.ts');
    const result = relativizeWorkflowPath(abs);
    assert.equal(result, 'nested/workflow.ts');
  });

  it('returns null for an absolute path outside cwd', () => {
    const outside = path.resolve(os.tmpdir(), 'not-in-cwd', 'workflow.ts');
    const result = relativizeWorkflowPath(outside);
    assert.equal(result, null);
  });

  it('returns null for a path that escapes cwd via ..', () => {
    const result = relativizeWorkflowPath('../escaped.ts');
    assert.equal(result, null);
  });

  it('returns null when the arg resolves to cwd itself', () => {
    const result = relativizeWorkflowPath('.');
    assert.equal(result, null);
  });
});
