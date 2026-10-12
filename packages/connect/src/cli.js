#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  ensureProbe,
  findLiveSocket,
  InstallError,
  linuxProbeSessionUpdateHint,
  probeSupportedOnPlatform,
  requireSupportedProbe,
  requireExistingProbe as findExistingProbe,
} from './install.js';
import { requestJson, requireOk, SocketResponseError } from './http.js';
import { identifyCaller, SessionNotFoundError } from './relay/identify.js';
import { ensureRelay, RelayStartError } from './relay/launch.js';
import { relayPaths } from './relay/paths.js';

const USAGE = `Usage:
  connect join <link-or-id> [--name <agent_name>] [--host-claim-stdin] [--json]
  connect send [--to <agent_name>] [--json]  # message text on stdin
  connect status [--json]
  connect leave [--json]
  connect install [--json]`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 64;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  if (command === '--version' || command === '-v') return { command: 'version' };
  if (!['join', 'send', 'status', 'leave', 'install'].includes(command)) {
    throw new UsageError(`Unknown command: ${command}`);
  }

  const options = { command, json: false, positionals: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--host-claim-stdin') options.hostClaimStdin = true;
    else if (argument === '--name' || argument === '--to') {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) throw new UsageError(`${argument} requires a value.`);
      options[argument === '--name' ? 'name' : 'to'] = value;
      index += 1;
    } else if (argument.startsWith('-')) throw new UsageError(`Unknown option: ${argument}`);
    else options.positionals.push(argument);
  }

  if (command === 'join') {
    if (options.positionals.length !== 1) throw new UsageError('join requires one link or Connect ID.');
  } else if (options.positionals.length > 0) {
    throw new UsageError(`${command} does not accept positional arguments.`);
  }
  if (command !== 'join' && (options.name || options.hostClaimStdin)) {
    throw new UsageError('--name and --host-claim-stdin are only valid with join.');
  }
  if (command !== 'send' && options.to) throw new UsageError('--to is only valid with send.');
  return options;
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function safeText(value, fallback = 'unknown') {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /(?:host_?claim|token|secret)/i.test(key) ? '[redacted]' : redact(entry),
    ])
  );
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(redact(value))}\n`);
}

async function version() {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(`${manifest.version}\n`);
}

function errorDetails(error) {
  const code = error?.code || error?.response?.error?.code;
  const known = {
    connect_invalid_request: ['Invalid Relay Connect request.', 64],
    connect_expired: ['Relay Connect has expired; ask the host for a new link.', 3],
    connect_ended: ['Relay Connect was ended by the host; stop sending.', 3],
    connect_not_found: ['Relay Connect is unavailable; ask the host to verify or replace the link.', 4],
    connect_name_taken: ['That agent name is already in use; choose another name.', 5],
    connect_full: ['Relay Connect is full.', 5],
    connect_claim_invalid: ['The host claim is invalid or already used; request a fresh claim.', 6],
    connect_rate_limited: ['Relay Connect is rate limited; wait and retry once.', 7],
    connect_unavailable: ['Relay Connect cloud service is unavailable; retry once.', 8],
    connect_not_joined: ['This agent session has not joined a Relay Connect.', 4],
    connect_already_joined: ['This agent session is already in a different Relay Connect.', 5],
    connect_join_pending: [
      'A previous join has an unknown outcome; retry with the same link and options.',
      8,
    ],
    connect_join_timeout: ['Relay Connect join timed out; retry the same join safely.', 8],
    connect_unreachable: ['Relay Connect cannot reach Cloud or Relaycast; retry once.', 8],
    agent_token_invalid: ['Relay Connect is over; run leave once to clear the local registration.', 3],
    not_a_relay_session: [
      "Agent Relay is running but could not match this command to a live Claude Code or Codex session. Run it from the agent's own shell tool, not a separate terminal; if it already is, update Claude Code or Codex and retry.",
      6,
    ],
  };
  if (code === 'session_file_unreadable') {
    return {
      message: safeText(
        error?.response?.error?.message,
        "This session's file cannot be read; resume the session and retry."
      ),
      exitCode: 6,
      code,
    };
  }
  if (error instanceof SessionNotFoundError || error instanceof RelayStartError) {
    return { message: safeText(error.message.split('\n')[0]) + tailOf(error.message), exitCode: error.exitCode, code };
  }
  if (known[code]) return { message: known[code][0], exitCode: known[code][1], code };
  if (error instanceof UsageError || error instanceof InstallError) {
    return { message: safeText(error.message, 'Relay Connect failed.'), exitCode: error.exitCode || 1, code };
  }
  if (error instanceof SocketResponseError) {
    return { message: `Relay Connect request failed (${safeText(code)}).`, exitCode: 1, code };
  }
  return {
    message: `Agent Relay probe is unavailable: ${safeText(error?.message, 'unknown error')}`,
    exitCode: 1,
    code,
  };
}

// Keeps the log tail a start failure carries, on its own lines.
function tailOf(message) {
  const lines = String(message).split('\n').slice(1);
  return lines.length ? `\n${lines.map((line) => safeText(line, '')).join('\n')}` : '';
}

async function requireExistingProbe() {
  const existing = await findExistingProbe({ home: os.homedir() });
  if (!existing)
    throw new InstallError('No live Agent Relay probe; run `npx -y @agent-relay/connect install`.');
  return existing;
}

function requireSessionOk(response, probe) {
  const hint = linuxProbeSessionUpdateHint(probe, response);
  if (hint) {
    const error = new InstallError(hint, 6);
    error.code = 'probe_update_required';
    error.response = { ...response, error: { ...response.error, message: hint } };
    throw error;
  }
  return requireOk(response);
}

function joinSummary(response, backend) {
  const data = response.data || {};
  const claudeNote =
    backend.kind === 'node'
      ? 'Claude Code note: Relay Connect sets "crossSessionInbound": "accept" in ~/.claude/settings.json so replies can be injected; the previous file is kept as settings.json.relay-desktop-backup.'
      : 'Claude Code note: the probe sets "crossSessionInbound": "accept" in ~/.claude/settings.json; undo it by POSTing {"enabled":false} to /setup/direct-delivery over the pointer socket (exact command in the package README).';
  const warnings = Array.isArray(data.warnings) ? data.warnings.map((warning) => `Warning: ${safeText(warning)}`) : [];
  const hostAgent = safeText(data.host?.agent_name);
  const hostPerson = safeText(data.host?.person, '');
  const host = hostPerson && hostPerson !== hostAgent ? `${hostPerson} (${hostAgent})` : hostAgent;
  return [
    `Joined Relay Connect as ${safeText(data.agent_name)} (${safeText(data.role)}).`,
    `Task: ${safeText(data.task, 'not provided')}`,
    `Host: ${host}`,
    `Expires: ${safeText(data.expires_at)}`,
    'How to talk:',
    '- Replies arrive injected into this session.',
    '- Send text on stdin: npx -y @agent-relay/connect send --to <name>',
    '- Check membership: npx -y @agent-relay/connect status',
    '- Leave: npx -y @agent-relay/connect leave',
    '- An ended or expired notice means the Connect is over; stop sending and do not silently rejoin.',
    ...(backend.kind === 'node'
      ? ['- After a restart, run status once to resume delivery: npx -y @agent-relay/connect status']
      : []),
    claudeNote,
    ...(backend.note ? [backend.note] : []),
    ...warnings,
  ].join('\n');
}

function statusSummary(response) {
  const data = response.data || {};
  const participants = Array.isArray(data.participants)
    ? data.participants
        .map((participant) => {
          const online =
            participant.online === true
              ? 'online'
              : participant.online === false
                ? 'offline'
                : 'unknown presence';
          return `${safeText(participant.agent_name)} (${safeText(participant.role)}, ${online})`;
        })
        .join(', ')
    : 'none';
  return [
    `Relay Connect ${safeText(data.connect_id)} as ${safeText(data.agent_name)} (${safeText(data.role)}).`,
    `Task: ${safeText(data.task, 'not provided')}`,
    `Expires: ${safeText(data.expires_at)}`,
    `Participants: ${participants || 'none'}`,
  ].join('\n');
}

async function run(options) {
  if (options.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.command === 'version') {
    await version();
    return;
  }
  if (options.command === 'install') {
    const result = await ensureProbe();
    if (options.json) printJson(result.status);
    else
      process.stdout.write(`Agent Relay probe ready${result.installed ? ' (installed and started)' : ''}.\n`);
    return;
  }

  const backend = await chooseBackend(options.command);
  if (options.command === 'join') {
    const body = { link: options.positionals[0] };
    if (options.name) body.name = options.name;
    if (options.hostClaimStdin) {
      const claim = (await stdinText()).trim();
      if (!claim) throw new UsageError('--host-claim-stdin requires a claim on stdin.');
      body.host_claim = claim;
    }
    const response = backend.check(
      await backend.call({
        method: 'POST',
        path: '/connect/join',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        timeoutMs: 60_000,
      })
    );
    delete body.host_claim;

    if (options.json) printJson(response);
    else process.stdout.write(`${joinSummary(response, backend)}\n`);
    return;
  }

  if (options.command === 'send') {
    const message = await stdinText();
    if (!message) throw new UsageError('send requires message text on stdin.');
    const suffix = options.to ? `?to=${encodeURIComponent(options.to)}` : '';
    const response = backend.check(
      await backend.call({
        method: 'POST',
        path: `/connect/send${suffix}`,
        body: message,
        headers: { 'x-agent-relay-request': randomUUID() },
      })
    );
    if (options.json) printJson(response);
    else {
      const recipients = (response.data?.sent || []).map((entry) => safeText(entry.to)).join(', ');
      process.stdout.write(`Sent${recipients ? ` to ${recipients}` : ''}.\n`);
    }
    return;
  }

  if (options.command === 'status') {
    const response = backend.check(await backend.call({ path: '/connect/status' }));
    if (options.json) printJson(response);
    else process.stdout.write(`${statusSummary(response)}\n`);
    return;
  }

  const response = backend.check(await backend.call({ method: 'POST', path: '/connect/leave' }));
  if (options.json) printJson(response);
  else process.stdout.write(`Left Relay Connect ${safeText(response.data?.connect_id)}.\n`);
}

async function nodeHoldsSession(home, target) {
  try {
    const state = JSON.parse(await readFile(relayPaths(home).state, 'utf8'));
    return Boolean(state?.sessions?.[`${target.kind}:${target.id}`]);
  } catch {
    return false;
  }
}

/**
 * Which local relay serves this command. The Node relay serves any session it
 * already holds; otherwise an eligible desktop probe is preferred; otherwise
 * `join` starts the Node relay. AGENT_RELAY_CONNECT_BACKEND=node|probe forces one.
 */
async function chooseBackend(command) {
  const home = os.homedir();
  const forced = process.env.AGENT_RELAY_CONNECT_BACKEND;
  const probeBackend = (probe) => ({
    kind: 'probe',
    call: (request) => requestJson(probe.socketPath, request),
    check: (response) => requireSessionOk(response, probe),
  });
  if (forced === 'probe') {
    return probeBackend(command === 'join' ? await ensureProbe() : await requireExistingProbe());
  }

  let target = null;
  let identifyError = null;
  try {
    target = await identifyCaller({ home });
  } catch (error) {
    if (!(error instanceof SessionNotFoundError)) throw error;
    identifyError = error;
  }
  const nodeBackend = async (note) => {
    const socket = await ensureRelay({ home });
    return {
      kind: 'node',
      note,
      call: (request) =>
        requestJson(socket, {
          ...request,
          headers: { ...request.headers, 'x-agent-relay-target': `${target.kind}:${target.id}` },
        }),
      check: (response) => requireOk(response),
    };
  };
  if (forced === 'node') {
    if (!target) throw identifyError;
    return await nodeBackend();
  }
  if (target && (await nodeHoldsSession(home, target))) return await nodeBackend();

  let probe = null;
  try {
    probe = await findLiveSocket(home, 2_000);
  } catch {
    // An unsafe or unreadable probe pointer is never used; the Node relay is.
    probe = null;
  }
  if (probe && !probe.sessionRejected) {
    if (probeSupportedOnPlatform(probe)) return probeBackend(probe);
    if (command === 'join' && target) {
      return await nodeBackend(
        `Note: Agent Relay ${safeText(probe.version)} is too old for Relay Connect, so this Connect uses the relay built into this package.`
      );
    }
    requireSupportedProbe(probe);
  }
  if (!target) {
    // The probe knows the session but cannot read its record: its reason is the useful one.
    if (probe?.status?.error?.code === 'session_file_unreadable') throw new SocketResponseError(probe.status);
    throw identifyError;
  }
  if (command === 'join') return await nodeBackend();
  throw new SocketResponseError({
    ok: false,
    error: { code: 'connect_not_joined', message: 'This agent session has not joined a Relay Connect.' },
  });
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    await run(options);
    return 0;
  } catch (error) {
    const details = errorDetails(error);
    if (options?.json && error?.response) printJson(error.response);
    else process.stderr.write(`${details.message}\n`);
    return details.exitCode;
  }
}

process.exitCode = await main();
