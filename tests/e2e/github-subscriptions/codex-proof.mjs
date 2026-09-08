import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import ts from 'typescript';

export const codexReceiverArgs = [
  '--model',
  'gpt-6-astra',
  '-c',
  'model_reasoning_effort="high"',
  '-c',
  'web_search="disabled"',
  '-c',
  'features.apps=false',
  '-c',
  'features.multi_agent=false',
  '-c',
  'features.code_mode=false',
  '-c',
  'features.code_mode_host=true',
];

export function codexMcpArgs({ node, cli, base, home }) {
  assert(home, 'An isolated MCP home is required; ambient workspace fallback discards an agent-only token');
  return Object.entries({
    command: node,
    args: [cli, 'mcp'],
    enabled_tools: ['post_message'],
    env_vars: ['RELAY_AGENT_TOKEN', 'RELAY_AGENT_NAME'],
    'env.RELAY_BASE_URL': base,
    'env.RELAY_AGENT_TYPE': 'agent',
    'env.RELAY_STRICT_AGENT_NAME': '1',
    'env.RELAY_SKIP_BOOTSTRAP': '1',
    'env.AGENT_RELAY_HOME': home,
  }).flatMap(([key, value]) => ['-c', `mcp_servers.agent-relay.${key}=${JSON.stringify(value)}`]);
}

// Fixed grammar, not a substring test: a digest followed by curl/read is forbidden.
export function isDigestOnlyCommand(command) {
  return /^printf '%s' '[a-f0-9]{32}' \| shasum -a 256$/.test(command);
}

function literalObject(node) {
  if (!ts.isObjectLiteralExpression(node)) throw new Error('Literal tool arguments required');
  return Object.fromEntries(
    node.properties.map((property) => {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
      )
        throw new Error('Plain argument properties required');
      const value = property.initializer;
      if (ts.isStringLiteral(value)) return [property.name.text, value.text];
      if (value.kind === ts.SyntaxKind.FalseKeyword) return [property.name.text, false];
      throw new Error('Only literal strings and false are permitted');
    })
  );
}

// Parse, never evaluate. Only one direct tool call wrapped in text(...) is allowed.
export function hostedToolCall(source) {
  const file = ts.createSourceFile('proof.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length || file.statements.length !== 1)
    throw new Error('One proof tool call required');
  const statement = file.statements[0];
  if (!ts.isExpressionStatement(statement)) throw new Error('Expected text(await tools.tool(...))');
  const outer = statement.expression;
  if (
    !ts.isCallExpression(outer) ||
    !ts.isIdentifier(outer.expression) ||
    outer.expression.text !== 'text' ||
    outer.arguments.length !== 1
  )
    throw new Error('Expected text wrapper');
  const awaited = outer.arguments[0];
  if (!ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression))
    throw new Error('Expected awaited call');
  const call = awaited.expression;
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !ts.isIdentifier(call.expression.expression) ||
    call.expression.expression.text !== 'tools' ||
    call.arguments.length !== 1
  )
    throw new Error('Direct tools call required');
  return { name: call.expression.name.text, args: literalObject(call.arguments[0]) };
}

export function auditCodexRecords(records) {
  const calls = [];
  for (const record of records) {
    if (record.type !== 'response_item') continue;
    const item = record.payload ?? {};
    if (!String(item.type).endsWith('_call')) continue;
    let args,
      name = item.name;
    try {
      if (item.type === 'custom_tool_call' && name === 'exec') {
        ({ name, args } = hostedToolCall(item.input));
      } else args = JSON.parse(item.arguments ?? '{}');
    } catch {
      args = {};
    }
    const command = args.cmd ?? args.command;
    const shell = name === 'exec_command' || name === 'shell_command';
    const post = name === 'mcp__agent-relay__post_message' || name === 'mcp__agent_relay__post_message';
    const admissible =
      (item.type === 'function_call' || (item.type === 'custom_tool_call' && name !== 'exec')) &&
      ((shell &&
        typeof command === 'string' &&
        isDigestOnlyCommand(command) &&
        Object.keys(args).every((k) => ['cmd', 'command', 'login'].includes(k)) &&
        (args.login === undefined || args.login === false)) ||
        (post &&
          args.channel === 'local-ai-proof' &&
          /^GHSUB_ACK [a-f0-9]{64}$/.test(args.text) &&
          Object.keys(args).every((k) => ['channel', 'text'].includes(k))));
    calls.push({
      at: record.timestamp,
      name: post ? 'mcp__agent-relay__post_message' : (name ?? item.type),
      admissible,
      ...(shell && typeof command === 'string'
        ? {
            commandSha256: createHash('sha256').update(command).digest('hex'),
            digestComputation: isDigestOnlyCommand(command),
          }
        : {}),
    });
  }
  return {
    calls,
    pass:
      calls.length > 0 &&
      calls.every((c) => c.admissible) &&
      calls.some((c) => c.digestComputation) &&
      calls.some((c) => c.name === 'mcp__agent-relay__post_message'),
  };
}

export function sessionFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

// Inspect metadata only for newly created sessions; read tool data only after exact owned-cwd match.
export async function auditOwnedCodexSession({ directory, before, cwd, startedAt }) {
  const owned = [];
  for (const file of sessionFiles(directory).filter((file) => !before.has(file))) {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let first;
    try {
      for await (const line of lines) {
        first = JSON.parse(line);
        break;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    if (first?.type !== 'session_meta' || !first.payload?.cwd) continue;
    if (![path.resolve(cwd), realpathSync(cwd)].includes(path.resolve(first.payload.cwd))) continue;
    assert(
      Date.parse(first.payload.timestamp) >= Date.parse(startedAt),
      'Owned Codex session predates proof'
    );
    owned.push({ file, id: first.payload.id, cliVersion: first.payload.cli_version });
  }
  assert.equal(owned.length, 1, 'Expected exactly one new Codex session in the owned proof cwd');
  const text = readFileSync(owned[0].file, 'utf8');
  const records = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return {
    ...auditCodexRecords(records),
    sessionId: owned[0].id,
    cliVersion: owned[0].cliVersion,
    transcriptSha256: createHash('sha256').update(text).digest('hex'),
  };
}
