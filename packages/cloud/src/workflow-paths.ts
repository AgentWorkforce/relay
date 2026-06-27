/**
 * Workflow path parsing: extract the `paths` declarations from a workflow file
 * (YAML or TypeScript) without executing it, plus file-type inference helpers.
 *
 * These are pure, side-effect-free parsers split out of `workflows.ts` so the
 * cloud execution code stays focused on auth/S3/API orchestration while the
 * text parsing stays small and independently testable. The TypeScript parser is
 * deliberately a lightweight literal scanner (not a full TS parse) — it only
 * needs to recover statically-declared `paths: [{ name, path, ... }]` entries.
 */
import path from 'node:path';

import type { WorkflowFileType } from './types.js';

export type WorkflowPathDefinition = {
  name: string;
  path: string;
  pushBranch?: string;
  pushBase?: string;
  pushPrBody?: string;
};

function stripYamlScalar(raw: string): string {
  const value = raw.trim();
  // Quoted scalars: locate the matching closing quote and strip a trailing
  // comment only after the close. Avoids corrupting values like
  // `"Fix issue #123"` where `#` is part of the string, not a YAML comment.
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const close = value.indexOf(quote, 1);
    if (close !== -1) {
      return value.slice(1, close);
    }
    // Unterminated quote — fall through and treat as a plain scalar.
  }
  // Unquoted scalar: a `#` preceded by whitespace starts a YAML comment.
  const commentIndex = value.search(/\s#/);
  if (commentIndex !== -1) {
    return value.slice(0, commentIndex).trim();
  }
  return value;
}

const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function setPathField(target: Partial<WorkflowPathDefinition>, key: string, value: string): void {
  switch (key) {
    case 'name':
      target.name = value;
      break;
    case 'path':
      target.path = value;
      break;
    case 'pushBranch':
      target.pushBranch = value;
      break;
    case 'pushBase':
      target.pushBase = value;
      break;
    case 'pushPrBody':
      target.pushPrBody = value;
      break;
  }
}

function assignPathField(target: Partial<WorkflowPathDefinition>, text: string): void {
  // Manual split avoids polynomial backtracking on inputs like "A:\t\t\t...".
  const colonIndex = text.indexOf(':');
  if (colonIndex === -1) return;
  const key = text.slice(0, colonIndex).trimEnd();
  if (!FIELD_KEY_RE.test(key)) return;
  setPathField(target, key, stripYamlScalar(text.slice(colonIndex + 1)));
}

const BLOCK_SCALAR_HEADER_RE = /^([|>])([+-]?)\d*\s*(#.*)?$/;

/**
 * Collect a YAML block scalar's body. Starting at `startIndex`, consume every
 * line indented deeper than `keyIndent` (blank lines included), dedent by the
 * block's own indentation, then join: literal (`|`) preserves newlines, folded
 * (`>`) joins each paragraph's lines with spaces and separates paragraphs with
 * a newline. Returns the joined content and the index of the last consumed line.
 */
function collectBlockScalar(
  lines: string[],
  startIndex: number,
  keyIndent: number,
  style: '|' | '>'
): { content: string; endIndex: number } {
  const body: string[] = [];
  let blockIndent = -1;
  let i = startIndex;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= keyIndent) break;
    if (blockIndent === -1) blockIndent = indent;
    body.push(line.slice(blockIndent));
  }
  // `i` now points at the first line outside the block (or past the end).
  while (body.length && body[body.length - 1] === '') body.pop();

  let content: string;
  if (style === '|') {
    content = body.join('\n');
  } else {
    const paragraphs: string[] = [];
    let buffer: string[] = [];
    for (const line of body) {
      if (line === '') {
        if (buffer.length) {
          paragraphs.push(buffer.join(' '));
          buffer = [];
        }
      } else {
        buffer.push(line);
      }
    }
    if (buffer.length) paragraphs.push(buffer.join(' '));
    content = paragraphs.join('\n');
  }
  return { content, endIndex: i - 1 };
}

/**
 * Assign one `key: value` field. If the value is a YAML block scalar header
 * (`|` or `>`, with optional chomping/comment), gather the following indented
 * lines as the field's content and return the index of the last consumed line;
 * otherwise assign the inline scalar and return `startIndex` unchanged.
 */
function assignPathFieldWithBlock(
  target: Partial<WorkflowPathDefinition>,
  text: string,
  keyIndent: number,
  lines: string[],
  startIndex: number
): number {
  const colonIndex = text.indexOf(':');
  if (colonIndex === -1) return startIndex;
  const key = text.slice(0, colonIndex).trimEnd();
  if (!FIELD_KEY_RE.test(key)) return startIndex;

  const rawValue = text.slice(colonIndex + 1).trim();
  const blockMatch = BLOCK_SCALAR_HEADER_RE.exec(rawValue);
  if (blockMatch) {
    const { content, endIndex } = collectBlockScalar(
      lines,
      startIndex + 1,
      keyIndent,
      blockMatch[1] as '|' | '>'
    );
    setPathField(target, key, content);
    return endIndex;
  }

  setPathField(target, key, stripYamlScalar(text.slice(colonIndex + 1)));
  return startIndex;
}

function parseYamlWorkflowPaths(content: string): WorkflowPathDefinition[] {
  const paths: WorkflowPathDefinition[] = [];
  const lines = content.split(/\r?\n/);
  let inPaths = false;
  let baseIndent = 0;
  let current: Partial<WorkflowPathDefinition> | null = null;

  const flush = () => {
    if (current?.name && current.path) {
      paths.push({
        name: current.name,
        path: current.path,
        ...(current.pushBranch ? { pushBranch: current.pushBranch } : {}),
        ...(current.pushBase ? { pushBase: current.pushBase } : {}),
        ...(current.pushPrBody ? { pushPrBody: current.pushPrBody } : {}),
      });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = rawLine.trim();

    if (!inPaths) {
      if (/^paths\s*:/.test(trimmed)) {
        inPaths = true;
        baseIndent = indent;
      }
      continue;
    }

    if (indent <= baseIndent && !trimmed.startsWith('-')) {
      break;
    }

    if (trimmed.startsWith('-')) {
      flush();
      current = {};
      const rest = trimmed.slice(1).trim();
      if (rest) assignPathField(current, rest);
      continue;
    }

    if (current) {
      // Property lines may carry a YAML block scalar (`pushPrBody: |`), whose
      // body spans the following more-indented lines; advance past them.
      i = assignPathFieldWithBlock(current, trimmed, indent, lines, i);
    }
  }
  flush();

  return paths;
}

/**
 * Strip `//` line comments and `/* ... *\/` block comments from TypeScript
 * source while leaving string and template literals intact. The literal scanner
 * below works on raw text, so without this a commented-out `paths` declaration
 * (e.g. `// paths: [{ name, path }]`) would be extracted as an active path and
 * synced. Block comments collapse to a single space to avoid joining adjacent
 * tokens.
 */
function stripTsComments(source: string): string {
  let out = '';
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue; // leave the terminating newline for the next iteration
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2; // skip the closing */
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function findMatchingBracket(source: string, startIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i] as '"' | "'" | '`' | string;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractPathArrayLiterals(source: string): string[] {
  const literals: string[] = [];

  const propertyPattern = /\bpaths\s*:/g;
  let propertyMatch: RegExpExecArray | null;
  while ((propertyMatch = propertyPattern.exec(source)) !== null) {
    const arrayStart = source.indexOf('[', propertyPattern.lastIndex);
    if (arrayStart === -1) continue;
    const arrayEnd = findMatchingBracket(source, arrayStart, '[', ']');
    if (arrayEnd !== -1) {
      literals.push(source.slice(arrayStart, arrayEnd + 1));
      propertyPattern.lastIndex = arrayEnd + 1;
    }
  }

  const methodPattern = /\.paths\s*\(/g;
  let methodMatch: RegExpExecArray | null;
  while ((methodMatch = methodPattern.exec(source)) !== null) {
    const arrayStart = source.indexOf('[', methodPattern.lastIndex);
    if (arrayStart === -1) continue;
    const arrayEnd = findMatchingBracket(source, arrayStart, '[', ']');
    if (arrayEnd !== -1) {
      literals.push(source.slice(arrayStart, arrayEnd + 1));
      methodPattern.lastIndex = arrayEnd + 1;
    }
  }

  return literals;
}

function extractObjectLiterals(arrayLiteral: string): string[] {
  const objects: string[] = [];
  for (let i = 0; i < arrayLiteral.length; i += 1) {
    if (arrayLiteral[i] !== '{') continue;
    const end = findMatchingBracket(arrayLiteral, i, '{', '}');
    if (end === -1) break;
    objects.push(arrayLiteral.slice(i, end + 1));
    i = end;
  }
  return objects;
}

function readStringProperty(objectLiteral: string, propertyName: string): string | null {
  const pattern = new RegExp(`\\b${propertyName}\\s*:\\s*(['"])(.*?)\\1`, 's');
  const match = objectLiteral.match(pattern);
  return match?.[2] ?? null;
}

function parseTypeScriptWorkflowPaths(content: string): WorkflowPathDefinition[] {
  const paths: WorkflowPathDefinition[] = [];
  const source = stripTsComments(content);
  for (const literal of extractPathArrayLiterals(source)) {
    for (const objectLiteral of extractObjectLiterals(literal)) {
      const name = readStringProperty(objectLiteral, 'name');
      const pathValue = readStringProperty(objectLiteral, 'path');
      if (name && pathValue) {
        const pushBranch = readStringProperty(objectLiteral, 'pushBranch');
        const pushBase = readStringProperty(objectLiteral, 'pushBase');
        const pushPrBody = readStringProperty(objectLiteral, 'pushPrBody');
        paths.push({
          name,
          path: pathValue,
          ...(pushBranch ? { pushBranch } : {}),
          ...(pushBase ? { pushBase } : {}),
          ...(pushPrBody ? { pushPrBody } : {}),
        });
      }
    }
  }
  return paths;
}

export function parseWorkflowPaths(content: string, fileType: WorkflowFileType): WorkflowPathDefinition[] {
  if (fileType === 'yaml') {
    return parseYamlWorkflowPaths(content);
  }
  if (fileType === 'ts') {
    return parseTypeScriptWorkflowPaths(content);
  }
  return [];
}

export function inferWorkflowFileType(filePath: string): WorkflowFileType | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.py':
      return 'py';
    default:
      return null;
  }
}

export function shouldSyncCodeByDefault(_workflowArg: string, _explicitFileType?: WorkflowFileType): boolean {
  return true;
}
