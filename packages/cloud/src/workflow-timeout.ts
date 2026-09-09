import type { WorkflowFileType } from './types.js';

export const DEFAULT_WORKFLOW_LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_EXPLICIT_WORKFLOW_LAUNCH_TIMEOUT_MS = 30 * 1000;
export const MAX_WORKFLOW_LAUNCH_TIMEOUT_MS = 55 * 60 * 1000;

function maskNonCode(source: string, fileType: Extract<WorkflowFileType, 'ts' | 'py'>): string {
  let output = '';
  let index = 0;
  let quote: "'" | '"' | '`' | null = null;
  let triple = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  const mask = (character: string) => (character === '\n' || character === '\r' ? character : ' ');

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    const third = source[index + 2];

    if (lineComment) {
      output += mask(character);
      if (character === '\n') lineComment = false;
      index += 1;
      continue;
    }

    if (blockComment) {
      output += mask(character);
      if (character === '*' && next === '/') {
        output += ' ';
        index += 2;
        blockComment = false;
      } else {
        index += 1;
      }
      continue;
    }

    if (quote) {
      output += mask(character);
      if (triple && character === quote && next === quote && third === quote) {
        output += '  ';
        index += 3;
        quote = null;
        triple = false;
        escaped = false;
        continue;
      }
      if (!triple) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
      }
      index += 1;
      continue;
    }

    if (fileType === 'ts' && character === '/' && next === '/') {
      output += '  ';
      index += 2;
      lineComment = true;
      continue;
    }
    if (fileType === 'ts' && character === '/' && next === '*') {
      output += '  ';
      index += 2;
      blockComment = true;
      continue;
    }
    if (fileType === 'py' && character === '#') {
      output += ' ';
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "'" || character === '"' || (fileType === 'ts' && character === '`')) {
      triple = fileType === 'py' && next === character && third === character;
      quote = character;
      output += triple ? '   ' : ' ';
      index += triple ? 3 : 1;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

function validateLaunchTimeoutMs(value: number, source: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${source} must be a positive safe integer of milliseconds`);
  }
  if (value < minimum) {
    throw new Error(`${source} must be at least ${minimum} milliseconds`);
  }
  if (value > MAX_WORKFLOW_LAUNCH_TIMEOUT_MS) {
    throw new Error(`${source} must not exceed ${MAX_WORKFLOW_LAUNCH_TIMEOUT_MS} milliseconds`);
  }
  return value;
}

/**
 * Infer the outer Cloud launch budget from a literal RelayFlow builder timeout
 * without evaluating submitted workflow code. Dynamic expressions are left
 * unresolved so callers can use the explicit launchTimeoutMs option instead.
 */
export function inferWorkflowLaunchTimeoutMs(
  workflow: string,
  fileType: WorkflowFileType
): number | undefined {
  if (fileType === 'yaml') return undefined;

  const source = maskNonCode(workflow, fileType);
  const values = new Set<number>();
  const timeoutPattern = /\.timeout\s*\(\s*([0-9](?:_?[0-9])*)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = timeoutPattern.exec(source)) !== null) {
    values.add(validateLaunchTimeoutMs(Number(match[1].replaceAll('_', '')), 'workflow .timeout()'));
  }

  if (values.size === 0) return undefined;
  if (values.size > 1) {
    throw new Error(
      'Workflow declares multiple distinct literal .timeout() values; pass launchTimeoutMs explicitly'
    );
  }
  const inferred = values.values().next().value;
  return inferred === undefined ? undefined : Math.max(DEFAULT_WORKFLOW_LAUNCH_TIMEOUT_MS, inferred);
}

export function resolveWorkflowLaunchTimeoutMs(
  workflow: string,
  fileType: WorkflowFileType,
  explicit?: number
): number | undefined {
  if (explicit !== undefined) {
    return validateLaunchTimeoutMs(explicit, 'launchTimeoutMs', MIN_EXPLICIT_WORKFLOW_LAUNCH_TIMEOUT_MS);
  }
  return inferWorkflowLaunchTimeoutMs(workflow, fileType);
}
