/**
 * Name an MCP session automatically when `relay mcp` starts without
 * RELAY_AGENT_NAME: the agent tool (from the client's `clientInfo.name`) plus
 * the project folder, for example `claude-myproject`. Two live sessions of the
 * same tool in the same folder get a short suffix (`claude-myproject-2`), so
 * they never take over each other's identity.
 */

import path from 'node:path';

/** Known MCP client names, matched on the start of `clientInfo.name`. */
const KNOWN_CLIENTS: ReadonlyArray<[RegExp, string]> = [
  [/^claude/, 'claude'], // claude-code
  [/^codex/, 'codex'], // codex-mcp-client
  [/^opencode/, 'opencode'],
  [/^grok/, 'grok'], // grok-shell, grok-shell-stub
  [/^pi(?:$|[-_ ])/, 'pi'],
  [/^devin/, 'devin'],
  [/^cursor/, 'cursor'],
  [/^gemini/, 'gemini'],
  [/^(?:visual-studio-code|vscode)/, 'vscode'],
  [/^windsurf/, 'windsurf'],
  [/^(?:droid|factory)/, 'droid'],
];

/** Client names that say which MCP library connected, not which tool. */
const GENERIC_CLIENTS = new Set(['', 'rmcp', 'mcp', 'client', 'mcp-client', 'unknown', 'test', 'node']);

const MAX_NAME_LENGTH = 48;

/**
 * Lower-case a value into an agent-name segment: letters, digits and single
 * dashes only.
 */
export function sanitizeNameSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The short tool label for a session.
 *
 * @param clientName - `clientInfo.name` from the MCP `initialize` request.
 * @param hint - AGENT_RELAY_CLIENT from the config `relay init` wrote, used
 *   when the client name is generic (Devin reports `rmcp`).
 * @returns A label such as `claude`, or `agent` when nothing identifies it.
 */
export function clientLabel(clientName?: string, hint?: string): string {
  const name = sanitizeNameSegment(clientName ?? '');
  for (const [pattern, label] of KNOWN_CLIENTS) if (pattern.test(name)) return label;
  const fromHint = sanitizeNameSegment(hint ?? '');
  if (fromHint) return fromHint;
  if (!GENERIC_CLIENTS.has(name)) {
    const trimmed = name.replace(/-(?:mcp-client|mcp|client|cli)$/, '');
    if (trimmed && !GENERIC_CLIENTS.has(trimmed)) return trimmed;
  }
  return 'agent';
}

/**
 * The base session name: `<tool>-<folder>`, sanitized and length-limited.
 *
 * @param input.clientName - `clientInfo.name` from the MCP client.
 * @param input.hint - AGENT_RELAY_CLIENT, when set.
 * @param input.cwd - The directory the tool started the server in.
 */
export function sessionBaseName(input: { clientName?: string; hint?: string; cwd: string }): string {
  const label = clientLabel(input.clientName, input.hint);
  const folder = sanitizeNameSegment(path.basename(path.resolve(input.cwd)));
  const name = folder ? `${label}-${folder}` : label;
  return name.slice(0, MAX_NAME_LENGTH).replace(/-+$/, '');
}

/**
 * The base name, or the first `-2`, `-3`, … variant no live session holds.
 *
 * @param base - From {@link sessionBaseName}.
 * @param live - Names of agents that are online right now.
 * @param random - Suffix source once the numbered variants run out.
 */
export function pickAvailableName(
  base: string,
  live: ReadonlySet<string>,
  random: () => string = () => Math.random().toString(16).slice(2, 6)
): string {
  if (!live.has(base)) return base;
  for (let n = 2; n <= 9; n += 1) {
    const candidate = `${base}-${n}`;
    if (!live.has(candidate)) return candidate;
  }
  return `${base}-${random()}`;
}
