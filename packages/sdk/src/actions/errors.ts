import type { ActionValidationIssue } from './types.js';

export class ActionRegistrationError extends Error {
  readonly code = 'action_registration_error';

  constructor(message: string) {
    super(message);
    this.name = 'ActionRegistrationError';
  }
}

export class ActionNotFoundError extends Error {
  readonly code = 'action_not_found';
  readonly action: string;

  constructor(action: string) {
    super(`No action registered for '${action}'`);
    this.name = 'ActionNotFoundError';
    this.action = action;
  }
}

export class ActionValidationError extends Error {
  readonly code = 'action_validation_error';
  readonly action: string;
  readonly phase: 'input' | 'output';
  readonly issues: ActionValidationIssue[];

  constructor(action: string, phase: 'input' | 'output', issues: ActionValidationIssue[]) {
    super(formatValidationMessage(action, phase, issues));
    this.name = 'ActionValidationError';
    this.action = action;
    this.phase = phase;
    this.issues = issues;
  }
}

function formatValidationMessage(
  action: string,
  phase: 'input' | 'output',
  issues: ActionValidationIssue[]
): string {
  const suffix = issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');

  return suffix
    ? `Action '${action}' ${phase} failed validation: ${suffix}`
    : `Action '${action}' ${phase} failed validation`;
}
