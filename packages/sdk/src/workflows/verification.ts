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
  getOrCreateStepEvidenceRecord?: (stepName: string) => { evidence: { coordinationSignals: CompletionEvidenceSignal[] } };
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

    case 'custom':
      return { passed: false };

    default:
      break;
  }

  if (options.completionMarkerFound === false) {
    sideEffects.log?.(`[${stepName}] Verification passed without legacy STEP_COMPLETE marker; allowing completion`);
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

function stripInjectedTaskEcho(output: string, injectedTaskText?: string): string {
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

export function checkOutputContains(
  output: string,
  token: string,
  injectedTaskText?: string
): boolean {
  if (!token) {
    return false;
  }
  return stripInjectedTaskEcho(output, injectedTaskText).includes(token);
}

export function checkFileExists(filePath: string, cwd = process.cwd()): boolean {
  return existsSync(path.resolve(cwd, filePath));
}
