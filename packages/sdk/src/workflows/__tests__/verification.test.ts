import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The module under test — does not exist yet (red phase).
import {
  runVerification,
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
      expect(() =>
        run({ type: 'output_contains', value: 'BUILD_SUCCESS' }, 'build failed')
      ).toThrow(WorkflowCompletionError);
    });

    it('should be case-sensitive', () => {
      expect(() =>
        run({ type: 'output_contains', value: 'BUILD_SUCCESS' }, 'build_success')
      ).toThrow(WorkflowCompletionError);
    });

    it('should return failure result instead of throwing when allowFailure is set', () => {
      const result = run(
        { type: 'output_contains', value: 'MISSING' },
        'no match here',
        'test-step',
        { allowFailure: true }
      );
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
      expect(() =>
        run({ type: 'file_exists', value: path.join(tmpDir, 'nope.txt') }, '')
      ).toThrow(WorkflowCompletionError);
    });
  });

  // 4. custom verification — returns { passed: false } (no-op in runner)
  describe('custom', () => {
    it('should return passed: false (delegated to caller)', () => {
      const result = run({ type: 'custom', value: 'anything' }, 'output');
      expect(result.passed).toBe(false);
    });
  });

  // 5. Invalid/unknown verification type — falls through gracefully
  describe('unknown type', () => {
    it('should fall through and pass for unknown verification types', () => {
      const result = run(
        { type: 'nonexistent' as VerificationCheck['type'], value: 'x' },
        'output'
      );
      // falls through the switch with no match, reaches success path
      expect(result.passed).toBe(true);
    });
  });

  // 6. completionMarkerFound option
  describe('completionMarkerFound option', () => {
    it('should log legacy marker message when completionMarkerFound is false', () => {
      const result = run(
        { type: 'exit_code', value: '0' },
        'output',
        'my-step',
        { completionMarkerFound: false }
      );
      expect(result.passed).toBe(true);
      expect(noopSideEffects.log).toHaveBeenCalledWith(
        expect.stringContaining('without legacy STEP_COMPLETE marker')
      );
    });
  });
});
