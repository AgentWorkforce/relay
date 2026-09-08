import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

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
  'features.code_mode_host=false',
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

export function auditCodexRecords(records) {
  const calls = [];
  for (const record of records) {
    if (record.type !== 'response_item') continue;
    const item = record.payload ?? {};
    if (!String(item.type).endsWith('_call')) continue;
    let args;
    try {
      args = JSON.parse(item.arguments ?? '{}');
    } catch {
      args = {};
    }
    const command = args.cmd ?? args.command;
    const shell = item.name === 'exec_command' || item.name === 'shell_command';
    const post = item.name === 'mcp__agent-relay__post_message';
    const admissible =
      item.type === 'function_call' &&
      ((shell && typeof command === 'string' && isDigestOnlyCommand(command)) || post);
    calls.push({
      at: record.timestamp,
      name: item.name ?? item.type,
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
