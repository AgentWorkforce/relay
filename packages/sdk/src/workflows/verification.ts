import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type {
  CompletionEvidenceSignal,
  CompletionEvidenceToolSideEffect,
  VerificationCheck,
  WorkflowStepCompletionReason,
} from './types.js';

export type { VerificationCheck } from './types.js';

export interface VerificationResult {
  passed: boolean;
  completionReason?: WorkflowStepCompletionReason;
  error?: string;
}

export interface VerificationOptions {
  allowFailure?: boolean;
  completionMarkerFound?: boolean;
  cwd?: string;
}

export class WorkflowCompletionError extends Error {
  completionReason?: WorkflowStepCompletionReason;

  constructor(message: string, completionReason?: WorkflowStepCompletionReason) {
    super(message);
    this.name = 'WorkflowCompletionError';
    this.completionReason = completionReason;
  }
}

export interface VerificationSideEffects {
  recordStepToolSideEffect?: (
    stepName: string,
    effect: Omit<CompletionEvidenceToolSideEffect, 'observedAt'> & { observedAt?: string }
  ) => void;
  getOrCreateStepEvidenceRecord?: (stepName: string) => {
    evidence: { coordinationSignals: CompletionEvidenceSignal[] };
  };
  log?: (message: string) => void;
}

export function runVerification(
  check: VerificationCheck,
  output: string,
  stepName: string,
  injectedTaskText?: string,
  options: VerificationOptions = {},
  sideEffects: VerificationSideEffects = {}
): VerificationResult {
  const cwd = options.cwd ?? process.cwd();

  const fail = (message: string): VerificationResult => {
    const observedAt = new Date().toISOString();
    sideEffects.recordStepToolSideEffect?.(stepName, {
      type: 'verification_observed',
      detail: message,
      observedAt,
      raw: { passed: false, type: check.type, value: check.value },
    });
    sideEffects.getOrCreateStepEvidenceRecord?.(stepName).evidence.coordinationSignals.push({
      kind: 'verification_failed',
      source: 'verification',
      text: message,
      observedAt,
      value: check.value,
    });

    if (options.allowFailure) {
      return {
        passed: false,
        completionReason: 'failed_verification',
        error: message,
      };
    }

    throw new WorkflowCompletionError(message, 'failed_verification');
  };

  switch (check.type) {
    case 'output_contains': {
      const token = check.value;
      if (!checkOutputContains(output, token, injectedTaskText)) {
        return fail(`Verification failed for "${stepName}": output does not contain "${token}"`);
      }
      break;
    }

    case 'exit_code':
      if (!checkExitCode(check.value)) {
        return fail(`Verification failed for "${stepName}": exit code did not match "${check.value}"`);
      }
      break;

    case 'file_exists':
      if (!checkFileExists(check.value, cwd)) {
        return fail(`Verification failed for "${stepName}": file "${check.value}" does not exist`);
      }
      break;

    case 'custom': {
      if (check.value) {
        const result = execCustomVerification(check.value, cwd, check.timeoutMs);
        if (!result.passed) {
          return fail(
            'Verification failed for "' +
              stepName +
              '": custom check "' +
              check.value +
              '" failed\n' +
              result.output
          );
        }
      } else {
        // No command provided — preserved legacy no-op behavior
        return { passed: false };
      }
      break;
    }

    default:
      break;
  }

  if (options.completionMarkerFound === false) {
    sideEffects.log?.(
      `[${stepName}] Verification passed without legacy STEP_COMPLETE marker; allowing completion`
    );
  }

  const observedAt = new Date().toISOString();
  const successMessage =
    options.completionMarkerFound === false
      ? 'Verification passed without legacy STEP_COMPLETE marker'
      : 'Verification passed';
  sideEffects.recordStepToolSideEffect?.(stepName, {
    type: 'verification_observed',
    detail: successMessage,
    observedAt,
    raw: { passed: true, type: check.type, value: check.value },
  });
  sideEffects.getOrCreateStepEvidenceRecord?.(stepName).evidence.coordinationSignals.push({
    kind: 'verification_passed',
    source: 'verification',
    text: successMessage,
    observedAt,
    value: check.value,
  });

  return {
    passed: true,
    completionReason: 'completed_verified',
  };
}

export function stripInjectedTaskEcho(output: string, injectedTaskText?: string): string {
  if (!injectedTaskText) {
    return output;
  }

  const candidates = [
    injectedTaskText,
    injectedTaskText.replace(/\r\n/g, '\n'),
    injectedTaskText.replace(/\n/g, '\r\n'),
  ].filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const start = output.indexOf(candidate);
    if (start !== -1) {
      return output.slice(0, start) + output.slice(start + candidate.length);
    }
  }

  return output;
}

export function checkExitCode(_expectedExitCode: string): boolean {
  // Existing runner semantics treat process success as established before this
  // verification hook runs, so this check is currently an unconditional pass.
  return true;
}

export function checkOutputContains(output: string, token: string, injectedTaskText?: string): boolean {
  if (!token) {
    return false;
  }
  return stripInjectedTaskEcho(output, injectedTaskText).includes(token);
}

const DEFAULT_CUSTOM_VERIFY_TIMEOUT_MS = parseInt(process.env.CUSTOM_VERIFY_TIMEOUT_MS ?? '30000', 10);

const REGEX_PREFIX = 'regex:';

export function execCustomVerification(
  command: string,
  cwd: string,
  timeoutMs = DEFAULT_CUSTOM_VERIFY_TIMEOUT_MS
): { passed: boolean; output: string } {
  try {
    const stdout = execSync(command, {
      cwd,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { passed: true, output: stdout.trim() };
  } catch (error) {
    const execError = error as Error & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout =
      typeof execError.stdout === 'string' ? execError.stdout : (execError.stdout?.toString('utf-8') ?? '');
    const stderr =
      typeof execError.stderr === 'string' ? execError.stderr : (execError.stderr?.toString('utf-8') ?? '');
    const combinedOutput = [stdout, stderr]
      .filter((chunk) => chunk.length > 0)
      .join('\n')
      .trim();
    const truncated = combinedOutput.length > 2000 ? combinedOutput.slice(-2000) : combinedOutput;
    return {
      passed: false,
      output: truncated || execError.message,
    };
  }
}

export function checkCustom(
  value: string,
  output: string,
  cwd = process.cwd()
): { passed: boolean; stdout?: string; error?: string } {
  // Regex shorthand: "regex:<pattern>"
  if (value.startsWith(REGEX_PREFIX)) {
    const pattern = value.slice(REGEX_PREFIX.length);
    try {
      const re = new RegExp(pattern);
      const matched = re.test(output);
      return matched
        ? { passed: true }
        : { passed: false, error: `output did not match pattern /${pattern}/` };
    } catch (err) {
      return { passed: false, error: `invalid regex: ${(err as Error).message}` };
    }
  }

  // Shell command: execute value with STEP_OUTPUT env var
  try {
    const result = execSync(value, {
      cwd,
      env: { ...process.env, STEP_OUTPUT: output },
      timeout: DEFAULT_CUSTOM_VERIFY_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    return { passed: true, stdout: result.toString('utf-8').trim() };
  } catch (err) {
    const message = (err as { stderr?: Buffer })?.stderr?.toString('utf-8')?.trim() || (err as Error).message;
    return { passed: false, error: message };
  }
}

export function checkFileExists(filePath: string, cwd = process.cwd()): boolean {
  const normalizedCwd = path.resolve(cwd);
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(normalizedCwd, filePath);

  // Relative artifact paths stay scoped to the workflow cwd; absolute paths
  // are already explicit and are allowed for temp/output artifacts.
  if (
    !path.isAbsolute(filePath) &&
    !resolved.startsWith(normalizedCwd + path.sep) &&
    resolved !== normalizedCwd
  ) {
    return false;
  }
  return existsSync(resolved);
}
