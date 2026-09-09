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
const TYPESCRIPT_DECLARATION_KEYWORDS = ['const', 'let', 'var', 'function', 'class'] as const;
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200c\u200d]/u;

function isLineTerminator(character: string | undefined): boolean {
  return character === '\n' || character === '\r' || character === '\u2028' || character === '\u2029';
}

type MaskedWorkflowSource = {
  source: string;
  matchingOpenParens: Map<number, number>;
  matchingCloseParens: Map<number, number>;
  matchingOpenBraces: Map<number, number>;
  matchingCloseBraces: Map<number, number>;
  scopeAt: Int32Array;
  scopeParents: Map<number, number>;
  nextNonWhitespace: Uint32Array;
};

type WorkflowRoot = { name: string; invoked: boolean };
type WorkflowBinding = { builder: boolean };
type ExpressionScope = { start: number; end: number; parameters: string };

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && IDENTIFIER_PART.test(character);
}

function identifierCodePointAt(source: string, index: number): string | undefined {
  const codePoint = source.codePointAt(index);
  if (codePoint === undefined) return undefined;
  const character = String.fromCodePoint(codePoint);
  return isIdentifierPart(character) ? character : undefined;
}

function unicodeIdentifierEscapeLength(source: string, index: number): number {
  if (source[index] !== '\\' || source[index + 1] !== 'u') return 0;
  if (source[index + 2] === '{') {
    let cursor = index + 3;
    let digits = 0;
    while (cursor < source.length && /[0-9A-Fa-f]/.test(source[cursor]) && digits < 6) {
      cursor += 1;
      digits += 1;
    }
    return digits > 0 && source[cursor] === '}' ? cursor - index + 1 : 0;
  }
  return /^[0-9A-Fa-f]{4}$/.test(source.slice(index + 2, index + 6)) ? 6 : 0;
}

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
  const mask = (character: string) => (isLineTerminator(character) ? character : ' ');
  let previousSignificantCharacter: string | undefined;
  let currentIdentifier = '';
  let lastIdentifier: string | undefined;
  let closedControlParen = false;
  let asiKeywordPending: string | undefined;
  let asiLabelCandidate = false;
  let lineBreakAfterAsiLabel = false;
  const controlParenStack: boolean[] = [];
  const openParenStack: number[] = [];
  const openBraceStack: number[] = [];
  const matchingOpenParens = new Map<number, number>();
  const matchingCloseParens = new Map<number, number>();
  const matchingOpenBraces = new Map<number, number>();
  const matchingCloseBraces = new Map<number, number>();
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
    if (isIdentifierPart(character)) {
      currentIdentifier += character;
      previousSignificantCharacter = character;
      closedControlParen = false;
      return;
    }

    flushIdentifier();
    if (/\s/.test(character)) {
      if (isLineTerminator(character)) recordLineBreak();
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
      openBraceStack.push(sourceIndex);
      const scopeId = nextScopeId++;
      scopeParents.set(scopeId, scopeStack[scopeStack.length - 1]);
      scopeStack.push(scopeId);
      lastIdentifier = undefined;
      closedControlParen = false;
      return;
    }
    if (character === '}') {
      const openBrace = openBraceStack.pop();
      if (openBrace !== undefined) {
        matchingOpenBraces.set(sourceIndex, openBrace);
        matchingCloseBraces.set(openBrace, sourceIndex);
      }
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
      if (isLineTerminator(character)) {
        recordLineBreak();
        lineComment = false;
      }
      index += 1;
      continue;
    }

    if (blockComment) {
      output += mask(character);
      if (isLineTerminator(character)) recordLineBreak();
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

    if (fileType === 'ts' && character === '\\') {
      const escapeLength = unicodeIdentifierEscapeLength(source, index);
      if (escapeLength > 0) {
        output += source.slice(index, index + escapeLength);
        for (let offset = 1; offset < escapeLength; offset += 1) {
          scopeAt[index + offset] = scopeStack[scopeStack.length - 1];
        }
        currentIdentifier += '_';
        previousSignificantCharacter = '_';
        closedControlParen = false;
        index += escapeLength;
        continue;
      }
    }

    const characterCode = source.charCodeAt(index);
    if (fileType === 'ts' && characterCode >= 0xd800 && characterCode <= 0xdbff) {
      const identifierCharacter = identifierCodePointAt(source, index);
      if (identifierCharacter !== undefined && identifierCharacter.length > 1) {
        output += identifierCharacter;
        currentIdentifier += identifierCharacter;
        previousSignificantCharacter = identifierCharacter;
        closedControlParen = false;
        for (let offset = 1; offset < identifierCharacter.length; offset += 1) {
          scopeAt[index + offset] = scopeStack[scopeStack.length - 1];
        }
        index += identifierCharacter.length;
        continue;
      }
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
    matchingOpenBraces,
    matchingCloseBraces,
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
    if (source[cursor] === ':') {
      cursor += 1;
      let delimiterDepth = 0;
      let angleDepth = 0;
      while (cursor < source.length) {
        const character = source[cursor];
        if (
          delimiterDepth === 0 &&
          angleDepth === 0 &&
          TYPESCRIPT_DECLARATION_KEYWORDS.some(
            (keyword) =>
              source.startsWith(keyword, cursor) &&
              !/[A-Za-z0-9_$]/.test(source[cursor - 1] ?? '') &&
              /\s/.test(source[cursor + keyword.length] ?? '')
          )
        ) {
          return false;
        }
        if (character === '(' || character === '[' || character === '{') delimiterDepth += 1;
        else if (character === ')' || character === ']' || character === '}') {
          delimiterDepth = Math.max(0, delimiterDepth - 1);
        } else if (character === '<') angleDepth += 1;
        else if (character === '>' && source[cursor - 1] !== '=') {
          angleDepth = Math.max(0, angleDepth - 1);
        } else if (
          character === '=' &&
          source[cursor + 1] !== '>' &&
          delimiterDepth === 0 &&
          angleDepth === 0
        ) {
          break;
        } else if (character === ';' && delimiterDepth === 0 && angleDepth === 0) {
          return false;
        }
        cursor += 1;
      }
    }
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

function nextNonWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  return cursor;
}

function functionBodyOpen(
  source: string,
  closeParen: number,
  nextNonWhitespaceByIndex: Uint32Array,
  matchingCloseBraces: ReadonlyMap<number, number>
): number | undefined {
  let cursor = nextNonWhitespaceByIndex[closeParen + 1] ?? source.length;
  if (source[cursor] === '{') return cursor;
  // TypeScript permits a return annotation between the parameter list and
  // body (`function f(x: T): Promise<void> { ... }`). If the annotation uses
  // an object type, skip that balanced type literal and select the following
  // body brace. Unterminated/ambiguous syntax is left unresolved.
  if (source[cursor] !== ':') return undefined;
  cursor = nextNonWhitespace(source, cursor + 1);
  let angleDepth = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '<') {
      angleDepth += 1;
      cursor += 1;
      continue;
    }
    if (character === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
      cursor += 1;
      continue;
    }
    if (character !== '{') {
      if (character === ';') return undefined;
      cursor += 1;
      continue;
    }
    const closeBrace = matchingCloseBraces.get(cursor);
    if (closeBrace === undefined) return undefined;
    if (angleDepth > 0) {
      cursor = closeBrace + 1;
      continue;
    }
    const afterBrace = nextNonWhitespace(source, closeBrace + 1);
    if (source[afterBrace] === '{') return afterBrace;
    return cursor;
  }
  return undefined;
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
  let segmentStart = 0;
  let delimiterDepth = 0;
  const recordSegment = (end: number): void => {
    const declaration = parameters
      .slice(segmentStart, end)
      .match(/^\s*(?:\.\.\.\s*)?(?:[{[]\s*)?([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (declaration !== null) names.add(declaration[1]);
  };
  for (let cursor = 0; cursor < parameters.length; cursor += 1) {
    const character = parameters[cursor];
    if (character === '(' || character === '[' || character === '{') delimiterDepth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      delimiterDepth = Math.max(0, delimiterDepth - 1);
    } else if (character === ',' && delimiterDepth === 0) {
      recordSegment(cursor);
      segmentStart = cursor + 1;
    }
  }
  recordSegment(parameters.length);
}

function pythonDelimiterDepth(source: string): Uint32Array {
  const depths = new Uint32Array(source.length);
  let depth = 0;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    depths[cursor] = depth;
    const character = source[cursor];
    if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth = Math.max(0, depth - 1);
  }
  return depths;
}

function resolveExpressionScopeEnds(
  source: string,
  scopes: ExpressionScope[],
  fileType: Extract<WorkflowFileType, 'ts' | 'py'>
): void {
  const active: Array<ExpressionScope & { depth: number; conditionalDepth: number }> = [];
  let scopeIndex = 0;
  let delimiterDepth = 0;

  const closeAt = (position: number): void => {
    while (active.length > 0 && active[active.length - 1].depth === delimiterDepth) {
      active.pop()!.end = position;
    }
  };

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    while (active.length > 0 && active[active.length - 1].end <= cursor) active.pop();
    while (scopeIndex < scopes.length && scopes[scopeIndex].start === cursor) {
      active.push(Object.assign(scopes[scopeIndex], { depth: delimiterDepth, conditionalDepth: 0 }));
      scopeIndex += 1;
    }

    const character = source[cursor];
    if (character === ')' || character === ']' || character === '}') {
      closeAt(cursor);
      delimiterDepth = Math.max(0, delimiterDepth - 1);
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      delimiterDepth += 1;
      continue;
    }
    if ((character === ';' || character === ',') && active.length > 0) {
      closeAt(cursor);
      continue;
    }
    if (
      fileType === 'ts' &&
      character === '?' &&
      source[cursor + 1] !== '?' &&
      source[cursor + 1] !== '.' &&
      source[cursor - 1] !== '?' &&
      active.length > 0 &&
      active[active.length - 1].depth === delimiterDepth
    ) {
      active[active.length - 1].conditionalDepth += 1;
      continue;
    }
    if (
      fileType === 'ts' &&
      character === ':' &&
      active.length > 0 &&
      active[active.length - 1].depth === delimiterDepth
    ) {
      while (active.length > 0 && active[active.length - 1].depth === delimiterDepth) {
        const scope = active[active.length - 1];
        if (scope.conditionalDepth > 0) {
          scope.conditionalDepth -= 1;
          break;
        }
        active.pop()!.end = cursor;
      }
      continue;
    }
    if (fileType === 'py' && (character === '\n' || character === '\r') && delimiterDepth === 0) {
      closeAt(cursor);
    }
  }

  while (active.length > 0) active.pop()!.end = source.length;
}

function applyExpressionScopes(
  masked: MaskedWorkflowSource,
  scopes: ExpressionScope[],
  functionScopes: Set<number>,
  functionBindings: Map<number, Set<string>>,
  varScopes?: Set<number>
): void {
  if (scopes.length === 0) return;

  const originalScopeAt = masked.scopeAt.slice();
  const originalScopeParents = new Map(masked.scopeParents);
  const registered: Array<ExpressionScope & { scopeId: number; baseScopeId: number }> = [];
  const parentStack: Array<ExpressionScope & { scopeId: number; baseScopeId: number }> = [];
  let nextScopeId = 1;
  for (const scopeId of masked.scopeParents.keys()) nextScopeId = Math.max(nextScopeId, scopeId + 1);

  for (const scope of scopes) {
    while (parentStack.length > 0 && parentStack[parentStack.length - 1].end <= scope.start) {
      parentStack.pop();
    }
    const scopeId = nextScopeId++;
    const baseScopeId = originalScopeAt[scope.start] ?? 0;
    const parentScope = parentStack[parentStack.length - 1]?.scopeId ?? baseScopeId;
    masked.scopeParents.set(scopeId, parentScope);
    functionScopes.add(scopeId);
    varScopes?.add(scopeId);
    addFunctionBinding(functionBindings, scopeId, scope.parameters);
    const record = { ...scope, scopeId, baseScopeId };
    registered.push(record);
    parentStack.push(record);
  }

  const active: Array<ExpressionScope & { scopeId: number; baseScopeId: number }> = [];
  let scopeIndex = 0;
  for (let cursor = 0; cursor < masked.source.length; cursor += 1) {
    while (active.length > 0 && active[active.length - 1].end <= cursor) active.pop();
    while (scopeIndex < registered.length && registered[scopeIndex].start === cursor) {
      active.push(registered[scopeIndex]);
      scopeIndex += 1;
    }
    if (active.length === 0) continue;
    const expressionScope = active[active.length - 1];
    const originalScopeId = originalScopeAt[cursor] ?? 0;
    if (originalScopeId === expressionScope.baseScopeId) {
      masked.scopeAt[cursor] = expressionScope.scopeId;
      continue;
    }
    // Preserve nested block/method/catch scopes. Their top-level child is
    // reparented under the expression scope so both the inner binding and the
    // enclosing arrow/lambda parameters stay visible without rewriting the
    // original scope id at every position.
    if (originalScopeParents.get(originalScopeId) === expressionScope.baseScopeId) {
      masked.scopeParents.set(originalScopeId, expressionScope.scopeId);
    }
  }
}

function pythonHeaderColon(source: string, start: number): number | undefined {
  let delimiterDepth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === '(' || character === '[' || character === '{') {
      delimiterDepth += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      delimiterDepth = Math.max(0, delimiterDepth - 1);
      continue;
    }
    if (character === ':' && delimiterDepth === 0) return cursor;
    if (character === '\n' || character === '\r') {
      const previous = previousNonWhitespace(source, cursor - 1);
      if (delimiterDepth === 0 && source[previous] !== '\\') return undefined;
      let nextLineToken = cursor + 1;
      while (source[nextLineToken] === ' ' || source[nextLineToken] === '\t') nextLineToken += 1;
      if (
        source.startsWith('def ', nextLineToken) ||
        (source.startsWith('async', nextLineToken) &&
          /\s/.test(source[nextLineToken + 'async'.length] ?? '') &&
          source.startsWith('def ', nextNonWhitespace(source, nextLineToken + 'async'.length)))
      ) {
        return undefined;
      }
      continue;
    }
    if (character === ';' && delimiterDepth === 0) return undefined;
  }
  return undefined;
}

function pythonParameterBindings(parameters: string): string {
  const names: string[] = [];
  let segmentStart = 0;
  let delimiterDepth = 0;
  const recordSegment = (end: number): void => {
    const segment = parameters.slice(segmentStart, end).trim();
    const match = segment.match(/^\*{0,2}\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (match !== null) names.push(match[1]);
  };

  for (let cursor = 0; cursor < parameters.length; cursor += 1) {
    const character = parameters[cursor];
    if (character === '(' || character === '[' || character === '{') delimiterDepth += 1;
    else if (character === ')' || character === ']' || character === '}') {
      delimiterDepth = Math.max(0, delimiterDepth - 1);
    } else if (character === ',' && delimiterDepth === 0) {
      recordSegment(cursor);
      segmentStart = cursor + 1;
    }
  }
  recordSegment(parameters.length);
  return names.join(',');
}

function collectPythonLambdaScopes(source: string): ExpressionScope[] {
  const scopes: ExpressionScope[] = [];
  const pending: Array<{ parametersStart: number; depth: number; nestedScopeIndexes: number[] }> = [];
  let delimiterDepth = 0;

  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (
      source.startsWith('lambda', cursor) &&
      !isIdentifierPart(source[cursor - 1]) &&
      !isIdentifierPart(source[cursor + 'lambda'.length])
    ) {
      pending.push({
        parametersStart: cursor + 'lambda'.length,
        depth: delimiterDepth,
        nestedScopeIndexes: [],
      });
      cursor += 'lambda'.length - 1;
      continue;
    }

    const character = source[cursor];
    if (character === '(' || character === '[' || character === '{') {
      delimiterDepth += 1;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      while (pending.length > 0 && pending[pending.length - 1].depth >= delimiterDepth) pending.pop();
      delimiterDepth = Math.max(0, delimiterDepth - 1);
      continue;
    }
    if (character === ':' && pending[pending.length - 1]?.depth === delimiterDepth) {
      const lambda = pending.pop()!;
      for (const nestedScopeIndex of lambda.nestedScopeIndexes) scopes[nestedScopeIndex].end = cursor;
      const scopeIndex = scopes.length;
      scopes.push({
        start: nextNonWhitespace(source, cursor + 1),
        end: source.length,
        parameters: pythonParameterBindings(source.slice(lambda.parametersStart, cursor)),
      });
      pending[pending.length - 1]?.nestedScopeIndexes.push(scopeIndex);
      continue;
    }
    if ((character === '\n' || character === '\r' || character === ';') && delimiterDepth === 0) {
      pending.length = 0;
    }
  }

  return scopes;
}

function collectPythonFunctionScopes(masked: MaskedWorkflowSource): {
  functionScopes: Set<number>;
  functionBindings: Map<number, Set<string>>;
  varScopes: Set<number>;
} {
  const {
    source,
    scopeAt,
    scopeParents,
    matchingCloseParens,
    nextNonWhitespace: nextNonWhitespaceByIndex,
  } = masked;
  const functionScopes = new Set<number>();
  const functionBindings = new Map<number, Set<string>>();
  const lines: Array<{ start: number; end: number; indent: number }> = [];
  let lineStart = 0;
  for (let cursor = 0; cursor <= source.length; cursor += 1) {
    if (cursor !== source.length && source[cursor] !== '\n') continue;
    let indent = 0;
    while (lineStart + indent < cursor) {
      const character = source[lineStart + indent];
      if (character === ' ') indent += 1;
      else if (character === '\t') indent += 4;
      else break;
    }
    lines.push({ start: lineStart, end: cursor, indent });
    lineStart = cursor + 1;
  }

  const declarations: Array<{
    name: string;
    colon: number;
    indent: number;
    parameters: string;
  }> = [];
  const declarationPattern = /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/gm;
  const declarationMatches = [...source.matchAll(declarationPattern)];
  const delimiterDepth = declarationMatches.length > 0 ? pythonDelimiterDepth(source) : undefined;
  let declarationLineIndex = 0;
  for (const declarationMatch of declarationMatches) {
    if (delimiterDepth?.[declarationMatch.index] !== 0) continue;
    const openParen = declarationMatch.index + declarationMatch[0].lastIndexOf('(');
    const closeParen = matchingCloseParens.get(openParen);
    if (closeParen === undefined) continue;
    const colon = pythonHeaderColon(source, nextNonWhitespaceByIndex[closeParen + 1] ?? source.length);
    if (colon === undefined) continue;
    while (
      declarationLineIndex + 1 < lines.length &&
      lines[declarationLineIndex].end < declarationMatch.index
    ) {
      declarationLineIndex += 1;
    }
    declarations.push({
      name: declarationMatch[1],
      colon,
      indent: lines[declarationLineIndex]?.indent ?? 0,
      parameters: pythonParameterBindings(source.slice(openParen + 1, closeParen)),
    });
  }

  const pending: Array<{ indent: number; parameters: string; parentScope: number }> = [];
  const stack: Array<{ indent: number; scopeId: number }> = [];
  let nextScopeId = 1;
  for (const scopeId of scopeParents.keys()) nextScopeId = Math.max(nextScopeId, scopeId + 1);
  let declarationIndex = 0;
  for (const line of lines) {
    const trimmed = source.slice(line.start + line.indent, line.end);
    if (trimmed.trim() === '') continue;
    while (stack.length > 0 && line.indent <= stack[stack.length - 1].indent) stack.pop();

    while (pending.length > 0 && line.indent > pending[0].indent) {
      const definition = pending.shift()!;
      const functionScope = nextScopeId++;
      scopeParents.set(functionScope, definition.parentScope);
      functionScopes.add(functionScope);
      addFunctionBinding(functionBindings, functionScope, definition.parameters);
      stack.push({ indent: definition.indent, scopeId: functionScope });
    }
    pending.length = 0;

    const scopeId = stack[stack.length - 1]?.scopeId ?? 0;
    for (let cursor = line.start; cursor < line.end; cursor += 1) scopeAt[cursor] = scopeId;

    while (declarationIndex < declarations.length && declarations[declarationIndex].colon <= line.end) {
      const definition = declarations[declarationIndex++];
      addFunctionBinding(functionBindings, scopeId, definition.name);
      const inlineBodyStart = nextNonWhitespaceByIndex[definition.colon + 1] ?? source.length;
      if (inlineBodyStart < line.end) {
        const functionScope = nextScopeId++;
        scopeParents.set(functionScope, scopeId);
        functionScopes.add(functionScope);
        addFunctionBinding(functionBindings, functionScope, definition.parameters);
        for (let cursor = inlineBodyStart; cursor < line.end; cursor += 1) {
          scopeAt[cursor] = functionScope;
        }
      } else {
        pending.push({
          indent: definition.indent,
          parameters: definition.parameters,
          parentScope: scopeId,
        });
      }
    }
  }

  // Python lambdas have expression scope rather than indentation scope. For
  // the static timeout scan, resolve all expression boundaries in one pass so
  // nested lambdas do not repeatedly rescan and rewrite the same suffix.
  const lambdaScopes = collectPythonLambdaScopes(source);
  resolveExpressionScopeEnds(source, lambdaScopes, 'py');
  applyExpressionScopes(masked, lambdaScopes, functionScopes, functionBindings);
  return { functionScopes, functionBindings, varScopes: functionScopes };
}

function collectFunctionScopes(
  masked: MaskedWorkflowSource,
  fileType: Extract<WorkflowFileType, 'ts' | 'py'>
): {
  functionScopes: Set<number>;
  functionBindings: Map<number, Set<string>>;
  varScopes: Set<number>;
} {
  const { source, matchingOpenParens, matchingCloseParens, matchingCloseBraces, scopeAt, nextNonWhitespace } =
    masked;
  const functionScopes = new Set<number>();
  const functionBindings = new Map<number, Set<string>>();
  const varScopes = new Set<number>();

  if (fileType === 'py') return collectPythonFunctionScopes(masked);

  const register = (openParen: number, parametersStart: number, parametersEnd: number): void => {
    const closeParen = matchingCloseParens.get(openParen);
    if (closeParen === undefined) return;
    const bodyOpen = functionBodyOpen(source, closeParen, nextNonWhitespace, matchingCloseBraces);
    if (bodyOpen === undefined || bodyOpen + 1 >= source.length) return;
    const scopeId = scopeAt[bodyOpen + 1] ?? 0;
    functionScopes.add(scopeId);
    varScopes.add(scopeId);
    addFunctionBinding(functionBindings, scopeId, source.slice(parametersStart, parametersEnd));
  };

  // Any parenthesized construct with a block body is structurally a function
  // or method unless its preceding token is a control-flow keyword. Register
  // the structural shape instead of requiring an identifier immediately before
  // `(` so computed and quoted class/object methods are covered as well.
  const controlBlockKeywords = new Set(['if', 'while', 'for', 'switch', 'with', 'catch']);
  for (const [openParen, closeParen] of matchingCloseParens) {
    const previous = previousNonWhitespace(source, openParen - 1);
    if (previous < 0) continue;
    const precedingIdentifier = identifierBefore(source, previous);
    if (precedingIdentifier !== null && controlBlockKeywords.has(precedingIdentifier.name)) continue;
    if (
      precedingIdentifier?.name === 'await' &&
      identifierBefore(source, precedingIdentifier.start - 1)?.name === 'for'
    ) {
      continue;
    }
    register(openParen, openParen + 1, closeParen);
  }

  // Catch bindings have their own lexical scope, represented by the catch
  // block's brace scope in the masked source.
  const catchPattern = /\bcatch\s*\(/g;
  let catchMatch: RegExpExecArray | null;
  while ((catchMatch = catchPattern.exec(source)) !== null) {
    const openParen = catchMatch.index + catchMatch[0].lastIndexOf('(');
    const closeParen = matchingCloseParens.get(openParen);
    if (closeParen === undefined) continue;
    const bodyOpen = nextNonWhitespace[closeParen + 1] ?? source.length;
    if (source[bodyOpen] !== '{' || bodyOpen + 1 >= source.length) continue;
    const scopeId = scopeAt[bodyOpen + 1] ?? 0;
    functionScopes.add(scopeId);
    addFunctionBinding(functionBindings, scopeId, source.slice(openParen + 1, closeParen));
  }

  const previousCloseParen = new Int32Array(source.length + 1);
  previousCloseParen.fill(-1);
  const previousArrowBoundary = new Int32Array(source.length + 1);
  previousArrowBoundary.fill(-1);
  let lastCloseParen = -1;
  let lastArrowBoundary = -1;
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    previousCloseParen[cursor] = lastCloseParen;
    previousArrowBoundary[cursor] = lastArrowBoundary;
    if (source[cursor] === ')') lastCloseParen = cursor;
    if (
      source[cursor] === ';' ||
      source[cursor] === '{' ||
      source[cursor] === '}' ||
      (source[cursor] === '=' && source[cursor + 1] !== '>')
    ) {
      lastArrowBoundary = cursor;
    }
  }
  previousCloseParen[source.length] = lastCloseParen;
  previousArrowBoundary[source.length] = lastArrowBoundary;

  const arrowParameters = (
    arrowIndex: number
  ): { parameters: string; parameterOpen?: number; typePosition: boolean } => {
    const previous = previousNonWhitespace(source, arrowIndex - 1);
    const boundary = previousArrowBoundary[arrowIndex];
    let parameterClose = previousCloseParen[arrowIndex];
    let directCandidate: { parameters: string; parameterOpen: number } | undefined;
    while (parameterClose > boundary) {
      const afterClose = nextNonWhitespace[parameterClose + 1] ?? source.length;
      const parameterOpen = matchingOpenParens.get(parameterClose);
      if (parameterOpen !== undefined) {
        if (source[afterClose] === ':' && afterClose < arrowIndex) {
          const beforeOpen = previousNonWhitespace(source, parameterOpen - 1);
          return {
            parameters: source.slice(parameterOpen + 1, parameterClose),
            parameterOpen,
            typePosition: source[beforeOpen] === ':',
          };
        }
        if (parameterClose === previous && directCandidate === undefined) {
          directCandidate = {
            parameters: source.slice(parameterOpen + 1, parameterClose),
            parameterOpen,
          };
          const beforeOpen = previousNonWhitespace(source, parameterOpen - 1);
          if (source[beforeOpen] !== ':' || !directCandidate.parameters.includes('=>')) {
            return {
              ...directCandidate,
              typePosition: source[beforeOpen] === ':',
            };
          }
        }
      }
      parameterClose = previousCloseParen[parameterClose];
    }
    if (directCandidate !== undefined) {
      const beforeOpen = previousNonWhitespace(source, directCandidate.parameterOpen - 1);
      return {
        ...directCandidate,
        typePosition: source[beforeOpen] === ':',
      };
    }
    const parameter = identifierBefore(source, previous);
    return { parameters: parameter?.name ?? '', typePosition: false };
  };

  // Track block and expression-bodied arrows. Expression bodies use compact
  // interval scopes applied in one sweep, avoiding repeated suffix rewrites for
  // nested arrows while preserving their parameter bindings.
  const expressionArrowScopes: ExpressionScope[] = [];
  const arrowPattern = /=>/g;
  let arrowMatch: RegExpExecArray | null;
  while ((arrowMatch = arrowPattern.exec(source)) !== null) {
    const bodyStart = nextNonWhitespace[arrowMatch.index + arrowMatch[0].length] ?? source.length;
    const { parameters, typePosition } = arrowParameters(arrowMatch.index);
    if (typePosition) continue;
    if (source[bodyStart] === '{') {
      if (bodyStart + 1 >= source.length) continue;
      const scopeId = scopeAt[bodyStart + 1] ?? 0;
      functionScopes.add(scopeId);
      varScopes.add(scopeId);
      addFunctionBinding(functionBindings, scopeId, parameters);
    } else {
      expressionArrowScopes.push({ start: bodyStart, end: source.length, parameters });
    }
  }
  resolveExpressionScopeEnds(source, expressionArrowScopes, 'ts');
  applyExpressionScopes(masked, expressionArrowScopes, functionScopes, functionBindings, varScopes);

  return { functionScopes, functionBindings, varScopes };
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
  const { functionScopes, functionBindings, varScopes } = collectFunctionScopes(masked, fileType);
  const bindings = new Map<number, Map<string, WorkflowBinding>>();
  const declarationPattern =
    fileType === 'ts'
      ? /\b(const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
      : /(?:^|[;\n])[ \t]*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n;]+)?=(?!=)/g;
  let declaration: RegExpExecArray | null;
  while ((declaration = declarationPattern.exec(source)) !== null) {
    const declarationKind = fileType === 'ts' ? declaration[1] : undefined;
    const declarationName = fileType === 'ts' ? declaration[2] : declaration[1];
    const declarationNameIndex =
      fileType === 'ts'
        ? declaration.index + declaration[0].lastIndexOf(declarationName)
        : declaration.index + declaration[0].indexOf(declarationName);
    const scopeId = masked.scopeAt[declarationNameIndex] ?? 0;
    const bindingScope =
      declarationKind === 'var' ? nearestFunctionScope(scopeId, varScopes, masked.scopeParents) : scopeId;
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
