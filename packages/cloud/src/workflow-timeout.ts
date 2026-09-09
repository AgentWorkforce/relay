import type { WorkflowFileType } from './types.js';

export const DEFAULT_WORKFLOW_LAUNCH_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_EXPLICIT_WORKFLOW_LAUNCH_TIMEOUT_MS = 30 * 1000;
export const MAX_WORKFLOW_LAUNCH_TIMEOUT_MS = 55 * 60 * 1000;

const REGEX_BOUNDARY_CHARACTERS = /[([{:;,!?=+\-*%&|^~<>}]/;
const REGEX_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'instanceof',
  'in',
  'of',
  'yield',
  'await',
  'else',
  'do',
]);
const CONTROL_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'with']);

type MaskedWorkflowSource = {
  source: string;
  matchingOpenParens: Map<number, number>;
};

type WorkflowRoot = { name: string; invoked: boolean };

function maskNonCode(source: string, fileType: Extract<WorkflowFileType, 'ts' | 'py'>): MaskedWorkflowSource {
  let output = '';
  let index = 0;
  let quote: "'" | '"' | '`' | null = null;
  let triple = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let regexLiteral = false;
  let regexCharacterClass = false;
  const mask = (character: string) => (character === '\n' || character === '\r' ? character : ' ');
  let previousSignificantCharacter: string | undefined;
  let currentIdentifier = '';
  let lastIdentifier: string | undefined;
  let closedControlParen = false;
  const controlParenStack: boolean[] = [];
  const openParenStack: number[] = [];
  const matchingOpenParens = new Map<number, number>();

  const flushIdentifier = () => {
    if (currentIdentifier) {
      lastIdentifier = currentIdentifier;
      currentIdentifier = '';
    }
  };

  const appendCode = (character: string, sourceIndex: number) => {
    output += character;
    if (/[A-Za-z0-9_$]/.test(character)) {
      currentIdentifier += character;
      previousSignificantCharacter = character;
      closedControlParen = false;
      return;
    }

    flushIdentifier();
    if (/\s/.test(character)) return;

    previousSignificantCharacter = character;
    if (character === '(') {
      openParenStack.push(sourceIndex);
      controlParenStack.push(lastIdentifier !== undefined && CONTROL_PAREN_KEYWORDS.has(lastIdentifier));
      lastIdentifier = undefined;
      closedControlParen = false;
      return;
    }
    if (character === ')') {
      const openParen = openParenStack.pop();
      if (openParen !== undefined) matchingOpenParens.set(sourceIndex, openParen);
      closedControlParen = controlParenStack.pop() ?? false;
      lastIdentifier = undefined;
      return;
    }

    lastIdentifier = undefined;
    closedControlParen = false;
  };

  // A slash starts a TypeScript regular-expression literal after an expression
  // boundary (or after a keyword such as `return`). Division follows an
  // expression and therefore remains visible code. This is intentionally
  // conservative: masking a possible regex is safer than inferring a timeout
  // from text inside it.
  const startsRegexLiteral = (): boolean => {
    if (fileType !== 'ts') return false;
    if (
      previousSignificantCharacter === undefined ||
      REGEX_BOUNDARY_CHARACTERS.test(previousSignificantCharacter)
    ) {
      return true;
    }
    if (previousSignificantCharacter === ')' && closedControlParen) return true;
    return REGEX_KEYWORDS.has(currentIdentifier || lastIdentifier || '');
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    const third = source[index + 2];

    if (regexLiteral) {
      output += mask(character);
      if (character === '\\') {
        if (next !== undefined) {
          output += mask(next);
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }
      if (character === '[') regexCharacterClass = true;
      if (character === ']' && regexCharacterClass) regexCharacterClass = false;
      if (character === '/' && !regexCharacterClass) {
        regexLiteral = false;
        previousSignificantCharacter = '/';
        currentIdentifier = '';
        lastIdentifier = undefined;
        closedControlParen = false;
      }
      index += 1;
      continue;
    }

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
      if (triple) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote && next === quote && third === quote) {
          output += '  ';
          index += 3;
          quote = null;
          triple = false;
          escaped = false;
          continue;
        }
      } else {
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
    if (character === '/' && startsRegexLiteral()) {
      output += ' ';
      index += 1;
      regexLiteral = true;
      regexCharacterClass = false;
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
      escaped = false;
      previousSignificantCharacter = character;
      currentIdentifier = '';
      lastIdentifier = undefined;
      closedControlParen = false;
      index += triple ? 3 : 1;
      continue;
    }

    appendCode(character, index);
    index += 1;
  }

  return { source: output, matchingOpenParens };
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

export function validateExplicitWorkflowLaunchTimeoutMs(explicit?: number): number | undefined {
  if (explicit === undefined) return undefined;
  return validateLaunchTimeoutMs(explicit, 'launchTimeoutMs', MIN_EXPLICIT_WORKFLOW_LAUNCH_TIMEOUT_MS);
}

function identifierBefore(source: string, end: number): { name: string; start: number } | null {
  let cursor = end;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  const finish = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor])) cursor -= 1;
  if (cursor + 1 === finish) return null;
  return { name: source.slice(cursor + 1, finish), start: cursor + 1 };
}

/**
 * Return the root expression for a fluent call immediately before `.timeout`.
 * The source has already had strings/comments/regex literals masked, and the
 * lexer has recorded balanced parentheses, so resolving a fluent call shares
 * structural work across repeated `.timeout()` candidates.
 */
function timeoutRoot(
  source: string,
  timeoutDot: number,
  matchingOpenParens: ReadonlyMap<number, number>,
  callRoots: Map<number, WorkflowRoot | null>
): WorkflowRoot | null {
  let cursor = timeoutDot - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;

  if (cursor >= 0 && source[cursor] === ')') {
    const pendingCalls: number[] = [];
    let root: WorkflowRoot | null = null;
    while (cursor >= 0 && source[cursor] === ')') {
      if (callRoots.has(cursor)) {
        root = callRoots.get(cursor) ?? null;
        break;
      }
      const open = matchingOpenParens.get(cursor);
      if (open === undefined) {
        root = null;
        break;
      }
      pendingCalls.push(cursor);
      const method = identifierBefore(source, open - 1);
      if (method === null) {
        root = null;
        break;
      }
      cursor = method.start - 1;
      while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
      if (cursor < 0 || source[cursor] !== '.') {
        root = { name: method.name, invoked: true };
        break;
      }
      cursor -= 1;
      while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
    }

    if (root === null && pendingCalls.length > 0 && (cursor < 0 || source[cursor] !== ')')) {
      const identifier = identifierBefore(source, cursor);
      root = identifier ? { name: identifier.name, invoked: false } : null;
    }
    for (const pendingCall of pendingCalls) callRoots.set(pendingCall, root);
    return root;
  }

  const identifier = identifierBefore(source, cursor);
  return identifier ? { name: identifier.name, invoked: false } : null;
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

  const masked = maskNonCode(workflow, fileType);
  const source = masked.source;
  const builderNames = new Set<string>();
  const assignmentPattern =
    fileType === 'ts'
      ? /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:await\s+)?workflow\s*\(/g
      : /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*workflow\s*\(/g;
  let assignment: RegExpExecArray | null;
  while ((assignment = assignmentPattern.exec(source)) !== null) {
    builderNames.add(assignment[1]);
  }

  const values = new Set<number>();
  let hasDynamicBuilderTimeout = false;
  const callRoots = new Map<number, WorkflowRoot | null>();
  const timeoutPattern = /\.timeout/g;
  let match: RegExpExecArray | null;
  while ((match = timeoutPattern.exec(source)) !== null) {
    let argumentStart = match.index + match[0].length;
    while (argumentStart < source.length && /\s/.test(source[argumentStart])) argumentStart += 1;
    if (source[argumentStart] !== '(') continue;
    argumentStart += 1;
    while (argumentStart < source.length && /\s/.test(source[argumentStart])) argumentStart += 1;
    const argumentEnd = source.indexOf(')', argumentStart);
    if (argumentEnd < 0) continue;

    const root = timeoutRoot(source, match.index, masked.matchingOpenParens, callRoots);
    if (root === null || (root.invoked ? root.name !== 'workflow' : !builderNames.has(root.name))) {
      continue;
    }
    const literal = source.slice(argumentStart, argumentEnd).match(/^[0-9](?:_?[0-9])*$/)?.[0];
    if (literal === undefined) {
      hasDynamicBuilderTimeout = true;
      continue;
    }
    values.add(validateLaunchTimeoutMs(Number(literal.replaceAll('_', '')), 'workflow .timeout()'));
  }

  // A literal and a dynamic builder timeout cannot be reconciled without
  // evaluating user code. Leave the metadata omitted so callers can provide
  // an explicit launchTimeoutMs override when they know the runtime value.
  if (hasDynamicBuilderTimeout) return undefined;
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
  if (explicit !== undefined) return validateExplicitWorkflowLaunchTimeoutMs(explicit);
  return inferWorkflowLaunchTimeoutMs(workflow, fileType);
}
