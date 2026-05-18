import { describe, expect, it } from 'vitest';
import path from 'node:path';

import {
  parseTsxStderr,
  formatWorkflowParseError,
  runScriptWorkflow,
  findLocalSdkWorkspace,
} from '../run-script.js';

describe('parseTsxStderr', () => {
  it('extracts file/line/col/message from inline `file:line:col: ERROR:` format', () => {
    const stderr = '/repo/workflow.ts:42:7: ERROR: Expected "}" but found end of file\n';
    const parsed = parseTsxStderr(stderr);

    expect(parsed).toEqual({
      file: '/repo/workflow.ts',
      line: 42,
      column: 7,
      message: 'Expected "}" but found end of file',
    });
  });

  it('extracts pretty-printed `✘ [ERROR]` format', () => {
    const stderr = `✘ [ERROR] Unexpected "$"

    /repo/workflow.ts:10:4:
      10 │   command: \`echo \${VAR}\`
         ╵     ^
`;
    const parsed = parseTsxStderr(stderr);

    expect(parsed).toMatchObject({
      file: '/repo/workflow.ts',
      line: 10,
      column: 4,
      message: 'Unexpected "$"',
    });
  });

  it('strips ANSI color codes before matching', () => {
    const stderr = '\x1b[31m/repo/workflow.ts:1:1: ERROR: bad token\x1b[0m\n';
    const parsed = parseTsxStderr(stderr);

    expect(parsed?.file).toBe('/repo/workflow.ts');
    expect(parsed?.message).toBe('bad token');
  });

  it('returns null when stderr does not look like a parse error', () => {
    expect(parseTsxStderr('Error: Cannot find module foo')).toBeNull();
    expect(parseTsxStderr('')).toBeNull();
  });
});

describe('formatWorkflowParseError', () => {
  it('produces a WORKFLOW_PARSE_ERROR with template-literal hints when applicable', () => {
    const err = formatWorkflowParseError({
      file: '/repo/workflow.ts',
      line: 12,
      column: 4,
      message: 'Unterminated template literal',
    });

    expect((err as Error & { code?: string }).code).toBe('WORKFLOW_PARSE_ERROR');
    expect(err.message).toContain('/repo/workflow.ts:12:4');
    expect(err.message).toMatch(/template literal/i);
  });

  it('falls back to the bare error when no hint is applicable', () => {
    const err = formatWorkflowParseError({
      file: '/repo/workflow.ts',
      message: 'TypeScript parse error (see tsx output above)',
    });

    expect(err.message).toContain('TypeScript parse error');
    expect(err.message).not.toMatch(/Hint:/);
  });
});

describe('runScriptWorkflow', () => {
  it('throws when the file does not exist', async () => {
    await expect(runScriptWorkflow('/definitely/does/not/exist.ts')).rejects.toThrow(/File not found/);
  });

  it('rejects unsupported extensions', async () => {
    // Use a file that exists (this test file itself) but with an unsupported ext —
    // there is no way to make the extension unsupported on a real path other than
    // pointing at one. Use the README as a stand-in.
    const fakePath = path.resolve(__dirname, '../../../README.md');
    await expect(runScriptWorkflow(fakePath)).rejects.toThrow(/Unsupported file type/);
  });
});

describe('findLocalSdkWorkspace', () => {
  it('returns null when no agent-relay workspace is in the ancestor chain', () => {
    expect(findLocalSdkWorkspace('/tmp')).toBeNull();
  });
});
