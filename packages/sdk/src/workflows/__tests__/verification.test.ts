import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The module under test — does not exist yet (red phase).
import {
  runVerification,
  stripInjectedTaskEcho,
  checkOutputContains,
  checkFileExists,
  checkCustom,
  execCustomVerification,
  type VerificationCheck,
  type VerificationResult,
  type VerificationOptions,
  WorkflowCompletionError,
} from '../verification.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const noopSideEffects = {
  recordStepToolSideEffect: vi.fn(),
  getOrCreateStepEvidenceRecord: vi.fn(() => ({
    evidence: { coordinationSignals: [] },
  })),
  log: vi.fn(),
};

function run(
  check: VerificationCheck,
  output: string,
  stepName = 'test-step',
  options?: VerificationOptions
): VerificationResult {
  return runVerification(check, output, stepName, undefined, options, noopSideEffects);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('verification logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. exit_code — pass on exit 0 (implicit success)
  describe('exit_code', () => {
    it('should pass when agent exited successfully (exit 0 implicit)', () => {
      const result = run({ type: 'exit_code', value: '0' }, 'some output');
      expect(result.passed).toBe(true);
      expect(result.completionReason).toBe('completed_verified');
    });

    it('should still pass for non-zero value (exit_code is implicitly satisfied)', () => {
      // per existing logic, exit_code case is a no-op — always passes if we reach it
      const result = run({ type: 'exit_code', value: '1' }, 'output');
      expect(result.passed).toBe(true);
    });
  });

  // 2. output_contains — case-sensitive substring match
  describe('output_contains', () => {
    it('should pass when output contains the token', () => {
      const result = run(
        { type: 'output_contains', value: 'BUILD_SUCCESS' },
        'Starting build...\nBUILD_SUCCESS\nDone.'
      );
      expect(result.passed).toBe(true);
      expect(result.completionReason).toBe('completed_verified');
    });

    it('should fail when output does not contain the token', () => {
      expect(() => run({ type: 'output_contains', value: 'BUILD_SUCCESS' }, 'build failed')).toThrow(
        WorkflowCompletionError
      );
    });

    it('should be case-sensitive', () => {
      expect(() => run({ type: 'output_contains', value: 'BUILD_SUCCESS' }, 'build_success')).toThrow(
        WorkflowCompletionError
      );
    });

    it('should return failure result instead of throwing when allowFailure is set', () => {
      const result = run({ type: 'output_contains', value: 'MISSING' }, 'no match here', 'test-step', {
        allowFailure: true,
      });
      expect(result.passed).toBe(false);
      expect(result.completionReason).toBe('failed_verification');
      expect(result.error).toContain('MISSING');
    });
  });

  // 3. file_exists — checks file presence at path
  describe('file_exists', () => {
    let tmpDir: string;
    let tmpFile: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
      tmpFile = path.join(tmpDir, 'artifact.txt');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should pass when the file exists', () => {
      fs.writeFileSync(tmpFile, 'content');
      // file_exists resolves relative to cwd; pass absolute path as value
      const result = run({ type: 'file_exists', value: tmpFile }, '');
      expect(result.passed).toBe(true);
    });

    it('should fail when the file does not exist', () => {
      expect(() => run({ type: 'file_exists', value: path.join(tmpDir, 'nope.txt') }, '')).toThrow(
        WorkflowCompletionError
      );
    });
  });

  // 4. custom verification — shell command execution
  describe('custom', () => {
    it('should pass when shell command exits 0', () => {
      const result = run({ type: 'custom', value: 'true' }, 'output');
      expect(result.passed).toBe(true);
      expect(result.completionReason).toBe('completed_verified');
    });

    it('should fail when shell command exits non-zero', () => {
      expect(() => run({ type: 'custom', value: 'false' }, 'output')).toThrow(WorkflowCompletionError);
    });

    it('should return failure with allowFailure', () => {
      const result = run({ type: 'custom', value: 'false' }, 'output', 'test-step', {
        allowFailure: true,
      });
      expect(result.passed).toBe(false);
      expect(result.completionReason).toBe('failed_verification');
    });

    it('should preserve legacy no-op behavior when no command is provided', () => {
      const result = run({ type: 'custom', value: '' }, 'output');
      expect(result).toEqual({ passed: false });
    });

    it('should include command output in the failure message', () => {
      const result = run(
        { type: 'custom', value: 'printf "compile failed" >&2; exit 1' },
        'output',
        'test-step',
        {
          allowFailure: true,
        }
      );
      expect(result.error).toContain('custom check "printf "compile failed" >&2; exit 1" failed');
      expect(result.error).toContain('compile failed');
    });
  });

  describe('execCustomVerification', () => {
    it('should return passed true for exit-0 command', () => {
      expect(execCustomVerification('true', process.cwd())).toEqual({ passed: true, output: '' });
    });

    it('should return passed false for exit-1 command', () => {
      const result = execCustomVerification('false', process.cwd());
      expect(result.passed).toBe(false);
      expect(result.output.length).toBeGreaterThanOrEqual(0);
    });

    it('should capture stdout from command', () => {
      const result = execCustomVerification('echo hello', process.cwd());
      expect(result.passed).toBe(true);
      expect(result.output).toBe('hello');
    });

    it('should capture stderr from a failing command', () => {
      const result = execCustomVerification('printf "boom" >&2; exit 1', process.cwd());
      expect(result.passed).toBe(false);
      expect(result.output).toContain('boom');
    });
  });

  // 4b. checkCustom unit tests
  describe('checkCustom', () => {
    it('should return passed true for exit-0 command', () => {
      expect(checkCustom('true', 'any')).toEqual({ passed: true, stdout: '' });
    });

    it('should return passed false for exit-1 command', () => {
      const result = checkCustom('false', 'any');
      expect(result.passed).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should capture stdout from command', () => {
      const result = checkCustom('echo hello', 'any');
      expect(result.passed).toBe(true);
      expect(result.stdout).toBe('hello');
    });

    it('should handle regex matching', () => {
      expect(checkCustom('regex:^foo', 'foobar')).toEqual({ passed: true });
      expect(checkCustom('regex:^foo', 'barfoo').passed).toBe(false);
    });

    it('should handle invalid regex gracefully', () => {
      const result = checkCustom('regex:[', 'any');
      expect(result.passed).toBe(false);
      expect(result.error).toContain('invalid regex');
    });
  });

  // 5. Invalid/unknown verification type — falls through gracefully
  describe('unknown type', () => {
    it('should fall through and pass for unknown verification types', () => {
      const result = run({ type: 'nonexistent' as VerificationCheck['type'], value: 'x' }, 'output');
      // falls through the switch with no match, reaches success path
      expect(result.passed).toBe(true);
    });
  });

  // 6. completionMarkerFound option
  describe('completionMarkerFound option', () => {
    it('should log legacy marker message when completionMarkerFound is false', () => {
      const result = run({ type: 'exit_code', value: '0' }, 'output', 'my-step', {
        completionMarkerFound: false,
      });
      expect(result.passed).toBe(true);
      expect(noopSideEffects.log).toHaveBeenCalledWith(
        expect.stringContaining('without legacy STEP_COMPLETE marker')
      );
    });
  });

  // 7. stripInjectedTaskEcho
  describe('stripInjectedTaskEcho', () => {
    it('should return output unchanged when no injectedTaskText', () => {
      expect(stripInjectedTaskEcho('hello world')).toBe('hello world');
      expect(stripInjectedTaskEcho('hello world', undefined)).toBe('hello world');
    });

    it('should strip the injected task text from output', () => {
      const task = 'Please run the build';
      const output = 'Starting...\nPlease run the build\nBUILD_SUCCESS';
      expect(stripInjectedTaskEcho(output, task)).toBe('Starting...\n\nBUILD_SUCCESS');
    });

    it('should handle CRLF normalization', () => {
      const task = 'Run task\r\nwith newlines';
      const output = 'prefix Run task\nwith newlines suffix';
      expect(stripInjectedTaskEcho(output, task)).toBe('prefix  suffix');
    });

    it('should handle LF to CRLF normalization', () => {
      const task = 'Run task\nwith newlines';
      const output = 'prefix Run task\r\nwith newlines suffix';
      expect(stripInjectedTaskEcho(output, task)).toBe('prefix  suffix');
    });

    it('should return output unchanged when task text is not found', () => {
      expect(stripInjectedTaskEcho('output text', 'not present')).toBe('output text');
    });

    it('should handle empty injected task text', () => {
      expect(stripInjectedTaskEcho('output', '')).toBe('output');
    });
  });

  // 8. checkOutputContains with injectedTaskText
  describe('checkOutputContains with injectedTaskText', () => {
    it('should not match token that only appears in injected task echo', () => {
      const task = 'Verify BUILD_SUCCESS appears';
      const output = 'Verify BUILD_SUCCESS appears\nDone.';
      expect(checkOutputContains(output, 'BUILD_SUCCESS', task)).toBe(false);
    });

    it('should match token that appears outside injected task echo', () => {
      const task = 'Run the build';
      const output = 'Run the build\nBUILD_SUCCESS';
      expect(checkOutputContains(output, 'BUILD_SUCCESS', task)).toBe(true);
    });

    it('should return false for empty token', () => {
      expect(checkOutputContains('anything', '', undefined)).toBe(false);
    });
  });

  // 9. checkFileExists path traversal protection
  describe('checkFileExists path traversal', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-traversal-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should reject path traversal with ../', () => {
      expect(checkFileExists('../../etc/passwd', tmpDir)).toBe(false);
    });

    it('should reject relative path with .. that resolves outside cwd', () => {
      expect(checkFileExists('../../../etc/passwd', tmpDir)).toBe(false);
    });

    it('should allow files within cwd', () => {
      const file = path.join(tmpDir, 'ok.txt');
      fs.writeFileSync(file, 'ok');
      expect(checkFileExists('ok.txt', tmpDir)).toBe(true);
    });
  });
});
