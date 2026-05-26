import fs from 'node:fs';
import path from 'node:path';

/**
 * Strip JSONC comments while preserving strings that contain // or /* sequences.
 * Uses a state machine to track whether we're inside a string literal.
 */
export function stripJsonComments(content: string): string {
  let result = '';
  let inString = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    // Handle string state (only when not in a comment)
    if (!inSingleLineComment && !inMultiLineComment) {
      if (char === '"' && (i === 0 || content[i - 1] !== '\\')) {
        inString = !inString;
        result += char;
        i++;
        continue;
      }

      // If in string, just copy the character
      if (inString) {
        result += char;
        i++;
        continue;
      }

      // Check for single-line comment start
      if (char === '/' && nextChar === '/') {
        inSingleLineComment = true;
        i += 2;
        continue;
      }

      // Check for multi-line comment start
      if (char === '/' && nextChar === '*') {
        inMultiLineComment = true;
        i += 2;
        continue;
      }

      // Not in any comment or string, copy the character
      result += char;
      i++;
      continue;
    }

    // Handle single-line comment end
    if (inSingleLineComment) {
      if (char === '\n') {
        inSingleLineComment = false;
        result += char; // Preserve newline
      }
      i++;
      continue;
    }

    // Handle multi-line comment end
    if (inMultiLineComment) {
      if (char === '*' && nextChar === '/') {
        inMultiLineComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }

  return result;
}

export function readJsonWithComments(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const sanitized = stripJsonComments(raw).trim();
    if (!sanitized) return {};
    return JSON.parse(sanitized);
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${(err as Error).message}`);
  }
}

export function writeJson(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}
