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
  'break',
  'continue',
  'debugger',
]);
const ASI_LABEL_KEYWORDS = new Set(['break', 'continue']);
const CONTROL_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'with']);

type MaskedWorkflowSource = {
  source: string;
  matchingOpenParens: Map<number, number>;
  matchingCloseParens: Map<number, number>;
  scopeAt: Int32Array;
  scopeParents: Map<number, number>;
  nextNonWhitespace: Uint32Array;
};

type WorkflowRoot = { name: string; invoked: boolean };
type WorkflowBinding = { builder: boolean };

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
  let asiKeywordPending: string | undefined;
  let asiLabelCandidate = false;
  let lineBreakAfterAsiLabel = false;
  const controlParenStack: boolean[] = [];
  const openParenStack: number[] = [];
  const matchingOpenParens = new Map<number, number>();
  const matchingCloseParens = new Map<number, number>();
  const scopeAt = new Int32Array(source.length);
  const scopeParents = new Map<number, number>([[0, -1]]);
  const scopeStack = [0];
  let nextScopeId = 1;

  const flushIdentifier = () => {
    if (currentIdentifier) {
      if (lastIdentifier !== undefined && ASI_LABEL_KEYWORDS.has(lastIdentifier)) {
        asiLabelCandidate = true;
      }
      if (asiKeywordPending !== undefined) {
        // `break label\n/regex/` is lexically a regex after the labelled
        // statement. Keep the ASI context until the label's line terminator
        // has been observed; a same-line slash remains ordinary code.
        asiLabelCandidate = true;
        asiKeywordPending = undefined;
      }
      lastIdentifier = currentIdentifier;
      currentIdentifier = '';
    }
  };

  const recordLineBreak = () => {
    if (lastIdentifier !== undefined && REGEX_KEYWORDS.has(lastIdentifier)) {
      asiKeywordPending = lastIdentifier;
    }
    if (asiLabelCandidate) lineBreakAfterAsiLabel = true;
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
    if (/\s/.test(character)) {
      if (character === '\n' || character === '\r') recordLineBreak();
      return;
    }

    // Any non-whitespace token other than the slash handled by the caller
    // ends the pending ASI/label context.
    asiKeywordPending = undefined;
    asiLabelCandidate = false;
    lineBreakAfterAsiLabel = false;

    previousSignificantCharacter = character;
    if (character === '(') {
      openParenStack.push(sourceIndex);
      controlParenStack.push(lastIdentifier !== undefined && CONTROL_PAREN_KEYWORDS.has(lastIdentifier));
      lastIdentifier = undefined;
      closedControlParen = false;
      return;
    }
    if (character === '{') {
      const scopeId = nextScopeId++;
      scopeParents.set(scopeId, scopeStack[scopeStack.length - 1]);
      scopeStack.push(scopeId);
      lastIdentifier = undefined;
      closedControlParen = false;
      return;
    }
    if (character === '}') {
      if (scopeStack.length > 1) scopeStack.pop();
      lastIdentifier = undefined;
      closedControlParen = false;
      return;
    }
    if (character === ')') {
      const openParen = openParenStack.pop();
      if (openParen !== undefined) {
        matchingOpenParens.set(sourceIndex, openParen);
        matchingCloseParens.set(openParen, sourceIndex);
      }
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
    if (asiKeywordPending !== undefined || lineBreakAfterAsiLabel) return true;
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
    scopeAt[index] = scopeStack[scopeStack.length - 1];

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
        asiKeywordPending = undefined;
        asiLabelCandidate = false;
        lineBreakAfterAsiLabel = false;
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
      if (character === '\n' || character === '\r') {
        recordLineBreak();
        lineComment = false;
      }
      index += 1;
      continue;
    }

    if (blockComment) {
      output += mask(character);
      if (character === '\n' || character === '\r') recordLineBreak();
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
      asiKeywordPending = undefined;
      asiLabelCandidate = false;
      lineBreakAfterAsiLabel = false;
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

  const nextNonWhitespace = new Uint32Array(output.length + 1);
  nextNonWhitespace[output.length] = output.length;
  for (let cursor = output.length - 1; cursor >= 0; cursor -= 1) {
    nextNonWhitespace[cursor] = /\s/.test(output[cursor]) ? nextNonWhitespace[cursor + 1] : cursor;
  }

  return {
    source: output,
    matchingOpenParens,
    matchingCloseParens,
    scopeAt,
    scopeParents,
    nextNonWhitespace,
  };
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

function bindingAt(
  name: string,
  scopeId: number,
  bindings: ReadonlyMap<number, ReadonlyMap<string, WorkflowBinding>>,
  scopeParents: ReadonlyMap<number, number>
): WorkflowBinding | null {
  let currentScope = scopeId;
  while (currentScope >= 0) {
    const scopeBindings = bindings.get(currentScope);
    const binding = scopeBindings?.get(name);
    if (binding !== undefined) return binding;
    currentScope = scopeParents.get(currentScope) ?? -1;
  }
  return null;
}

function workflowInitializerAt(
  source: string,
  end: number,
  fileType: Extract<WorkflowFileType, 'ts' | 'py'>
): boolean {
  let cursor = end;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (fileType === 'ts') {
    if (source[cursor] !== '=') return false;
    cursor += 1;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    if (source.startsWith('await', cursor) && !/[A-Za-z0-9_$]/.test(source[cursor + 5] ?? '')) {
      cursor += 5;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    }
  }
  if (!source.startsWith('workflow', cursor)) return false;
  const afterName = source[cursor + 'workflow'.length] ?? '';
  if (/[A-Za-z0-9_$]/.test(afterName)) return false;
  cursor += 'workflow'.length;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return source[cursor] === '(';
}

function previousNonWhitespace(source: string, end: number): number {
  let cursor = end;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  return cursor;
}

function addFunctionBinding(
  functionBindings: Map<number, Set<string>>,
  scopeId: number,
  parameters: string
): void {
  let names = functionBindings.get(scopeId);
  if (names === undefined) {
    names = new Set();
    functionBindings.set(scopeId, names);
  }
  // This is deliberately a conservative lexical scan. Marking names from a
  // parameter's type/default/destructuring pattern as shadowed can omit an
  // inference, but never turns unrelated code into a false builder timeout.
  for (const parameter of parameters.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    names.add(parameter[0]);
  }
}

function collectFunctionScopes(masked: MaskedWorkflowSource): {
  functionScopes: Set<number>;
  functionBindings: Map<number, Set<string>>;
} {
  const { source, matchingOpenParens, matchingCloseParens, scopeAt, nextNonWhitespace } = masked;
  const functionScopes = new Set<number>();
  const functionBindings = new Map<number, Set<string>>();

  const register = (openParen: number, parametersStart: number, parametersEnd: number): void => {
    const closeParen = matchingCloseParens.get(openParen);
    if (closeParen === undefined) return;
    const bodyOpen = nextNonWhitespace[closeParen + 1] ?? source.length;
    if (source[bodyOpen] !== '{' || bodyOpen + 1 >= source.length) return;
    const scopeId = scopeAt[bodyOpen + 1] ?? 0;
    functionScopes.add(scopeId);
    addFunctionBinding(functionBindings, scopeId, source.slice(parametersStart, parametersEnd));
  };

  // Function declarations and expressions.
  const functionPattern = /\bfunction\s*\*?\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s*)?\(/g;
  let functionMatch: RegExpExecArray | null;
  while ((functionMatch = functionPattern.exec(source)) !== null) {
    const openParen = functionMatch.index + functionMatch[0].lastIndexOf('(');
    register(openParen, openParen + 1, matchingCloseParens.get(openParen) ?? openParen + 1);
  }

  // Block-bodied arrow functions. Expression-bodied arrows introduce no
  // lexical block that this scanner needs to model.
  const arrowPattern = /=>/g;
  let arrowMatch: RegExpExecArray | null;
  while ((arrowMatch = arrowPattern.exec(source)) !== null) {
    const bodyOpen = nextNonWhitespace[arrowMatch.index + arrowMatch[0].length] ?? source.length;
    if (source[bodyOpen] !== '{' || bodyOpen + 1 >= source.length) continue;
    const scopeId = scopeAt[bodyOpen + 1] ?? 0;
    functionScopes.add(scopeId);
    const parameterEnd = previousNonWhitespace(source, arrowMatch.index - 1) + 1;
    const parameterEndCharacter = parameterEnd - 1;
    if (source[parameterEndCharacter] === ')') {
      const openParen = matchingOpenParens.get(parameterEndCharacter);
      if (openParen !== undefined) {
        addFunctionBinding(functionBindings, scopeId, source.slice(openParen + 1, parameterEndCharacter));
      }
    } else {
      const parameter = identifierBefore(source, parameterEnd);
      if (parameter !== null) addFunctionBinding(functionBindings, scopeId, parameter.name);
    }
  }

  return { functionScopes, functionBindings };
}

function nearestFunctionScope(
  scopeId: number,
  functionScopes: ReadonlySet<number>,
  scopeParents: ReadonlyMap<number, number>
): number {
  let currentScope = scopeId;
  while (currentScope > 0 && !functionScopes.has(currentScope)) {
    currentScope = scopeParents.get(currentScope) ?? 0;
  }
  return currentScope;
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
  const { functionScopes, functionBindings } = collectFunctionScopes(masked);
  const bindings = new Map<number, Map<string, WorkflowBinding>>();
  const declarationPattern =
    fileType === 'ts'
      ? /\b(const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
      : /\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  let declaration: RegExpExecArray | null;
  while ((declaration = declarationPattern.exec(source)) !== null) {
    const scopeId = masked.scopeAt[declaration.index] ?? 0;
    const declarationKind = fileType === 'ts' ? declaration[1] : undefined;
    const declarationName = fileType === 'ts' ? declaration[2] : declaration[1];
    const bindingScope =
      declarationKind === 'var'
        ? nearestFunctionScope(scopeId, functionScopes, masked.scopeParents)
        : scopeId;
    let scopeBindings = bindings.get(scopeId);
    if (scopeBindings === undefined || bindingScope !== scopeId) {
      scopeBindings = bindings.get(bindingScope);
    }
    if (scopeBindings === undefined) {
      scopeBindings = new Map();
      bindings.set(bindingScope, scopeBindings);
    }
    const builder = workflowInitializerAt(source, declaration.index + declaration[0].length, fileType);
    scopeBindings.set(declarationName, { builder });
  }

  for (const [scopeId, names] of functionBindings) {
    let scopeBindings = bindings.get(scopeId);
    if (scopeBindings === undefined) {
      scopeBindings = new Map();
      bindings.set(scopeId, scopeBindings);
    }
    for (const name of names) scopeBindings.set(name, { builder: false });
  }

  const values = new Set<number>();
  let hasUnresolvedBuilderTimeout = false;
  const callRoots = new Map<number, WorkflowRoot | null>();
  const timeoutPattern = /\.timeout/g;
  let match: RegExpExecArray | null;
  while ((match = timeoutPattern.exec(source)) !== null) {
    const afterTimeout = masked.nextNonWhitespace[match.index + match[0].length] ?? source.length;
    if (source[afterTimeout] !== '(') continue;
    const argumentOpen = afterTimeout;
    const argumentStart = masked.nextNonWhitespace[argumentOpen + 1] ?? source.length;
    const argumentEnd = masked.matchingCloseParens.get(argumentOpen);
    if (argumentEnd === undefined) continue;

    const root = timeoutRoot(source, match.index, masked.matchingOpenParens, callRoots);
    if (root === null) continue;
    const scopeId = masked.scopeAt[match.index] ?? 0;
    const binding = bindingAt(root.name, scopeId, bindings, masked.scopeParents);
    if (root.invoked) {
      if (root.name !== 'workflow' || binding !== null) continue;
    } else if (binding?.builder !== true) {
      continue;
    }
    const literal = source
      .slice(argumentStart, argumentEnd)
      .trim()
      .match(/^[0-9](?:_?[0-9])*$/)?.[0];
    if (literal === undefined) {
      hasUnresolvedBuilderTimeout = true;
      continue;
    }
    try {
      values.add(validateLaunchTimeoutMs(Number(literal.replaceAll('_', '')), 'workflow .timeout()'));
    } catch {
      // A script literal outside the inferred metadata contract is still user
      // code we cannot safely evaluate. Omit inference and let callers provide
      // an explicit, strictly validated launchTimeoutMs instead.
      hasUnresolvedBuilderTimeout = true;
    }
  }

  // A dynamic or out-of-range builder timeout cannot be reconciled without
  // evaluating user code. Leave the metadata omitted so callers can provide
  // an explicit launchTimeoutMs override when they know the runtime value.
  if (hasUnresolvedBuilderTimeout) return undefined;
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
