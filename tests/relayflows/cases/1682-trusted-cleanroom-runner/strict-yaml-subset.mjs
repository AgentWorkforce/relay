/**
 * Parse the deliberately small YAML subset used by the two trusted cleanroom
 * workflows. The hosted RelayFlow case cannot rely on repository dependencies:
 * each proof arm is checked out into an isolated directory without node_modules.
 *
 * This parser is fail-closed. Unsupported flow mappings, tabs, malformed
 * indentation, and duplicate keys are rejected instead of being approximated.
 */
export function parseStrictWorkflowYaml(source) {
  if (typeof source !== 'string') throw new TypeError('YAML source must be a string.');
  const tokens = tokenize(source.replace(/^\uFEFF/, ''));
  let cursor = 0;

  function peek() {
    return tokens[cursor];
  }

  function parseNode(indent) {
    const token = peek();
    if (!token || token.indent !== indent) {
      throw syntaxError(token, `expected a node at indentation ${indent}`);
    }
    return token.text === '-' || token.text.startsWith('- ') ? parseSequence(indent) : parseMapping(indent);
  }

  function parseMapping(indent) {
    const result = {};
    while (peek()?.indent === indent && peek().text !== '-' && !peek().text.startsWith('- ')) {
      const token = tokens[cursor++];
      assignPair(result, token.text, token);
    }
    return result;
  }

  function parseSequence(indent) {
    const result = [];
    while (peek()?.indent === indent && (peek().text === '-' || peek().text.startsWith('- '))) {
      const token = tokens[cursor++];
      const rest = token.text === '-' ? '' : token.text.slice(2).trim();
      if (!rest) {
        result.push(parseNested(token));
        continue;
      }
      if (mappingColon(rest) >= 0) {
        const entry = {};
        assignPair(entry, rest, token);
        const child = peek();
        if (child && child.indent > indent) {
          const continuation = parseMapping(child.indent);
          for (const [key, value] of Object.entries(continuation)) assignUnique(entry, key, value, token);
        }
        result.push(entry);
        continue;
      }
      if (token.blockValue !== undefined) {
        throw syntaxError(token, 'a literal block must belong to a mapping key');
      }
      result.push(parseScalar(rest, token));
    }
    return result;
  }

  function assignPair(target, text, token) {
    const separator = mappingColon(text);
    if (separator < 1) throw syntaxError(token, 'expected a mapping key and colon');
    const rawKey = text.slice(0, separator).trim();
    const key = parseKey(rawKey, token);
    const rawValue = text.slice(separator + 1).trim();
    let value;
    if (token.blockValue !== undefined) {
      if (rawValue !== '|' && rawValue !== '|-' && rawValue !== '|+') {
        throw syntaxError(token, 'literal block marker must be the complete mapping value');
      }
      value = token.blockValue;
    } else if (rawValue) {
      value = parseScalar(rawValue, token);
    } else {
      value = parseNested(token);
    }
    assignUnique(target, key, value, token);
  }

  function parseNested(parent) {
    const child = peek();
    if (!child || child.indent <= parent.indent) return null;
    return parseNode(child.indent);
  }

  const parsed = tokens.length === 0 ? {} : parseNode(tokens[0].indent);
  if (cursor !== tokens.length) throw syntaxError(peek(), 'unexpected indentation or sequence continuation');
  return parsed;
}

function tokenize(source) {
  const lines = source.split(/\r?\n/);
  const tokens = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.includes('\t')) throw new Error(`Unsupported YAML tab at line ${index + 1}.`);
    const indent = raw.match(/^ */)[0].length;
    const text = stripComment(raw.slice(indent)).trimEnd();
    if (!text.trim()) continue;
    const token = { indent, text: text.trim(), line: index + 1 };
    const separator = mappingColon(token.text === '-' ? '' : token.text.replace(/^- /, ''));
    const value =
      separator < 0
        ? ''
        : token.text
            .replace(/^- /, '')
            .slice(separator + 1)
            .trim();
    if (value === '|' || value === '|-' || value === '|+') {
      const block = [];
      let blockIndent;
      let next = index + 1;
      for (; next < lines.length; next += 1) {
        const candidate = lines[next];
        const candidateIndent = candidate.match(/^ */)[0].length;
        if (candidate.trim() && candidateIndent <= indent) break;
        if (candidate.trim() && blockIndent === undefined) blockIndent = candidateIndent;
        block.push(candidate);
      }
      if (blockIndent === undefined) throw syntaxError(token, 'literal block has no content');
      const literal = block.map((line) => (line.trim() ? line.slice(blockIndent) : '')).join('\n');
      token.blockValue =
        value === '|+' ? `${literal}\n` : `${literal.replace(/\n+$/, '')}${value === '|' ? '\n' : ''}`;
      index = next - 1;
    }
    tokens.push(token);
  }
  return tokens;
}

function stripComment(value) {
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote && character === quote && value[index - 1] !== '\\') quote = undefined;
    else if (!quote && (character === "'" || character === '"')) quote = character;
    else if (!quote && character === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index);
    }
  }
  if (quote) throw new Error('Unterminated quoted YAML scalar.');
  return value;
}

function mappingColon(value) {
  let quote;
  let squareDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote && character === quote && value[index - 1] !== '\\') quote = undefined;
    else if (!quote && (character === "'" || character === '"')) quote = character;
    else if (!quote && character === '[') squareDepth += 1;
    else if (!quote && character === ']') squareDepth -= 1;
    else if (!quote && squareDepth === 0 && character === ':') return index;
  }
  return -1;
}

function parseKey(raw, token) {
  const key = parseQuotedOrPlain(raw, token);
  if (typeof key !== 'string' || !key) throw syntaxError(token, 'mapping key must be a non-empty string');
  return key;
}

function parseScalar(raw, token) {
  if (raw === '{}') return {};
  if (raw === '[]') return [];
  if (raw.startsWith('{')) throw syntaxError(token, 'flow mappings are not supported');
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) throw syntaxError(token, 'unterminated flow sequence');
    const body = raw.slice(1, -1).trim();
    return body ? splitFlowSequence(body, token).map((value) => parseScalar(value, token)) : [];
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?(?:0|[1-9]\d*)$/.test(raw)) return Number(raw);
  return parseQuotedOrPlain(raw, token);
}

function parseQuotedOrPlain(raw, token) {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw syntaxError(token, `invalid double-quoted scalar: ${error.message}`);
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw syntaxError(token, 'invalid single-quoted scalar');
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

function splitFlowSequence(value, token) {
  const entries = [];
  let quote;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote && character === quote && value[index - 1] !== '\\') quote = undefined;
    else if (!quote && (character === "'" || character === '"')) quote = character;
    else if (!quote && character === ',') {
      entries.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  entries.push(value.slice(start).trim());
  if (entries.some((entry) => !entry)) throw syntaxError(token, 'empty flow-sequence entry');
  return entries;
}

function assignUnique(target, key, value, token) {
  if (Object.hasOwn(target, key)) throw syntaxError(token, `duplicate mapping key ${JSON.stringify(key)}`);
  target[key] = value;
}

function syntaxError(token, message) {
  return new Error(
    `Unsupported or invalid workflow YAML${token?.line ? ` at line ${token.line}` : ''}: ${message}.`
  );
}
