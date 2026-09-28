import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_LINE_BYTES = 1_000_000;
const MAX_CODEX_MESSAGE_BYTES = 120_000;

export type CodingSessionHarness = 'codex' | 'claude';

export interface CodingSessionTarget {
  harness: CodingSessionHarness;
  sessionId: string;
}

export type InjectionOutcome =
  | { kind: 'injected' }
  | { kind: 'retry'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'in-doubt'; reason: string };

export type DeliveryInjector = (input: {
  text: string;
  messageId: string;
  sessionId: string;
}) => Promise<InjectionOutcome>;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeHarness(value: string | undefined): CodingSessionHarness | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'claude' || normalized === 'claude-code' || normalized === 'claudecode') {
    return 'claude';
  }
  return undefined;
}

export interface ResolveCodingSessionTargetOptions {
  harness?: string;
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  detectedHarness?: string;
  discoverClaudeSession?: () => Promise<string | undefined>;
}

/** Resolve the current harness/session without guessing a session owned by another process. */
export async function resolveCodingSessionTarget(
  options: ResolveCodingSessionTargetOptions = {}
): Promise<CodingSessionTarget> {
  const env = options.env ?? process.env;
  const explicitHarness = nonEmpty(options.harness);
  const codexSession =
    nonEmpty(env.CODEX_THREAD_ID) ??
    nonEmpty(env.CODEX_SESSION_ID) ??
    (env.AI_HIST_CURRENT_SOURCE === 'codex' ? nonEmpty(env.AI_HIST_CURRENT_SESSION_ID) : undefined);
  const claudeSession =
    nonEmpty(env.CLAUDE_CODE_SESSION_ID) ??
    (env.AI_HIST_CURRENT_SOURCE === 'claude' ? nonEmpty(env.AI_HIST_CURRENT_SESSION_ID) : undefined);

  let harness = normalizeHarness(explicitHarness);
  if (explicitHarness && !harness && explicitHarness !== 'auto') {
    throw new Error(`Unsupported harness "${explicitHarness}". Use codex, claude, or auto.`);
  }
  harness ??=
    normalizeHarness(nonEmpty(env.RELAY_ON_RELAY_HARNESS)) ??
    normalizeHarness(nonEmpty(env.AGENT_RELAY_HARNESS)) ??
    normalizeHarness(nonEmpty(env.AGENT_RELAY_ORCHESTRATOR_HARNESS));
  if (!harness && codexSession && !claudeSession) harness = 'codex';
  if (!harness && claudeSession && !codexSession) harness = 'claude';
  harness ??= normalizeHarness(options.detectedHarness);

  if (!harness) {
    throw new Error(
      'Could not detect Codex or Claude Code. Pass --harness codex|claude and --session-id <id>.'
    );
  }

  let sessionId =
    nonEmpty(options.sessionId) ??
    nonEmpty(env.RELAY_ON_RELAY_SESSION_ID) ??
    (harness === 'codex' ? codexSession : claudeSession);
  if (!sessionId && harness === 'claude') {
    sessionId = await (options.discoverClaudeSession ?? discoverCurrentClaudeSession)();
  }
  if (!sessionId && isUuid(env.RELAY_ATTEST_SESSION_ID ?? '')) {
    sessionId = env.RELAY_ATTEST_SESSION_ID;
  }
  if (!sessionId) {
    throw new Error(
      `Could not determine the ${harness} session id. Pass --session-id or set ${
        harness === 'codex' ? 'CODEX_THREAD_ID' : 'CLAUDE_CODE_SESSION_ID'
      }.`
    );
  }
  if (!isUuid(sessionId)) {
    throw new Error(`The ${harness} session id must be a UUID.`);
  }
  return { harness, sessionId };
}

export interface HarnessInjectorOptions {
  harness: CodingSessionHarness;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  claudeRegistryDir?: string;
}

/** Create a reusable adapter that injects one relay delivery into a coding session. */
export function createHarnessInjector(options: HarnessInjectorOptions): DeliveryInjector {
  if (options.harness === 'codex') {
    return (input) => injectCodex(input, options.env);
  }
  return (input) =>
    injectClaudeTerminal(input, {
      env: options.env,
      registryDir: options.claudeRegistryDir,
    });
}

interface CommandResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  errorCode?: string;
}

function runBoundedCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, {
        env,
        cwd: os.tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        code: null,
        stdout: '',
        timedOut: false,
        errorCode: (error as NodeJS.ErrnoException).code,
      });
      return;
    }
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 64_000) stdout += chunk.toString('utf8').slice(0, 64_000 - stdout.length);
    });
    // Always drain stderr, but never surface it: some CLIs echo argv, which
    // would copy the incoming message into logs.
    child.stderr.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      finish({ code: null, stdout, timedOut, errorCode: (error as NodeJS.ErrnoException).code });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, timedOut });
    });
  });
}

export async function injectCodex(
  input: { text: string; messageId: string; sessionId: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<InjectionOutcome> {
  if (!isUuid(input.sessionId)) return { kind: 'retry', reason: 'invalid Codex thread id' };
  if (Buffer.byteLength(input.text) > MAX_CODEX_MESSAGE_BYTES) {
    return { kind: 'rejected', reason: 'message exceeds the portable codex queue argument limit' };
  }
  const command = nonEmpty(env.RELAY_CODEX_BIN) ?? 'codex';
  const result = await runBoundedCommand(
    command,
    ['queue', '--thread', input.sessionId, `--message=${input.text}`],
    20_000,
    env
  );
  if (result.timedOut) return { kind: 'in-doubt', reason: 'codex queue timed out' };
  if (result.code === 0) return { kind: 'injected' };
  if (result.errorCode === 'E2BIG') {
    return { kind: 'rejected', reason: 'message exceeds the portable codex queue argument limit' };
  }
  return { kind: 'retry', reason: result.code === null ? 'codex is not installed' : 'codex queue refused' };
}

interface ClaudeSessionRecord {
  sessionId: string;
  pid: number;
  socketPath: string;
  peerProtocol: number;
  procStart?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' && record[key] ? record[key] : undefined;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function claudeRegistryDirectory(env: NodeJS.ProcessEnv): string {
  const root = nonEmpty(env.CLAUDE_CONFIG_DIR) ?? path.join(nonEmpty(env.HOME) ?? os.homedir(), '.claude');
  return path.join(root, 'sessions');
}

function parseClaudeSession(data: string): ClaudeSessionRecord | undefined {
  let value: Record<string, unknown>;
  try {
    value = asRecord(JSON.parse(data));
  } catch {
    return undefined;
  }
  const sessionId = stringField(value, 'sessionId');
  const socketPath = stringField(value, 'messagingSocketPath');
  const pid = value.pid;
  if (!sessionId || !isUuid(sessionId) || !socketPath || typeof pid !== 'number' || pid <= 0) {
    return undefined;
  }
  return {
    sessionId,
    pid,
    socketPath,
    peerProtocol: typeof value.peerProtocol === 'number' ? value.peerProtocol : 0,
    ...(value.procStart !== undefined ? { procStart: String(value.procStart) } : {}),
  };
}

async function linuxProcessStart(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = value
      .slice(value.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/);
    return fields[19];
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function liveClaudeSession(
  sessionId: string,
  registryDir: string
): Promise<ClaudeSessionRecord | undefined> {
  let files: string[];
  try {
    files = await readdir(registryDir);
  } catch {
    return undefined;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let record: ClaudeSessionRecord | undefined;
    try {
      record = parseClaudeSession(await readFile(path.join(registryDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!record || record.sessionId !== sessionId || !processAlive(record.pid)) continue;
    if (record.procStart) {
      const currentStart = await linuxProcessStart(record.pid);
      if (currentStart && currentStart !== record.procStart) continue;
    }
    return record;
  }
  return undefined;
}

async function claudePeerToken(
  session: ClaudeSessionRecord,
  registryDir: string
): Promise<string | undefined> {
  let files: string[];
  try {
    files = await readdir(registryDir);
  } catch {
    return undefined;
  }
  for (const file of files) {
    if (!file.startsWith(`${session.pid}.`) || !file.endsWith('.key')) continue;
    try {
      const record = asRecord(JSON.parse(await readFile(path.join(registryDir, file), 'utf8')));
      const token = stringField(record, 'peerToken');
      if (!token) continue;
      if (
        record.procStart !== undefined &&
        session.procStart !== undefined &&
        String(record.procStart) === session.procStart
      ) {
        return token;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function claudePeerFrames(token: string, messageId: string, text: string): string {
  const auth = JSON.stringify({ type: 'auth', token });
  const message = JSON.stringify({
    type: 'user',
    msg_id: messageId,
    uuid: randomUUID().toUpperCase(),
    priority: 'next',
    message: { role: 'user', content: text },
  });
  if (Buffer.byteLength(message) > MAX_LINE_BYTES) {
    throw new Error(`message exceeds Claude Code's ${MAX_LINE_BYTES}-byte inbox limit`);
  }
  return `${auth}\n${message}\n`;
}

export async function injectClaudeTerminal(
  input: { text: string; messageId: string; sessionId: string },
  options: { env?: NodeJS.ProcessEnv; registryDir?: string } = {}
): Promise<InjectionOutcome> {
  const env = options.env ?? process.env;
  const registryDir = options.registryDir ?? claudeRegistryDirectory(env);
  const session = await liveClaudeSession(input.sessionId, registryDir);
  if (!session) return { kind: 'retry', reason: 'Claude Code session is not running' };
  if (session.peerProtocol !== 1) {
    return { kind: 'retry', reason: `unsupported Claude Code peer protocol ${session.peerProtocol}` };
  }
  const token = await claudePeerToken(session, registryDir);
  if (!token) return { kind: 'retry', reason: 'Claude Code inbox key is unavailable' };
  let frames: string;
  try {
    frames = claudePeerFrames(token, input.messageId, input.text);
  } catch (error) {
    return { kind: 'rejected', reason: safeErrorMessage(error) };
  }
  return new Promise((resolve) => {
    let connected = false;
    let writing = false;
    let settled = false;
    const socket = net.createConnection({ path: session.socketPath });
    const finish = (outcome: InjectionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish(
        connected || writing
          ? { kind: 'in-doubt', reason: 'Claude Code inbox timed out while sending' }
          : { kind: 'retry', reason: 'Claude Code inbox did not accept a connection' }
      );
    }, 5_000);
    socket.once('connect', () => {
      connected = true;
      writing = true;
      // Peer protocol 1 has no acceptance receipt. Match relay-desktop: a
      // completed write means the turn was handed to Claude Code's inbox.
      socket.end(frames, 'utf8', () => finish({ kind: 'injected' }));
    });
    socket.once('error', () => {
      finish(
        writing
          ? { kind: 'in-doubt', reason: 'Claude Code inbox connection broke while sending' }
          : { kind: 'retry', reason: 'could not reach the Claude Code inbox' }
      );
    });
  });
}

async function discoverCurrentClaudeSession(): Promise<string | undefined> {
  const registryDir = claudeRegistryDirectory(process.env);
  let files: string[];
  try {
    files = await readdir(registryDir);
  } catch {
    return undefined;
  }
  const ancestors = [...(await ancestorPids(process.ppid))];
  const candidates: ClaudeSessionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = parseClaudeSession(await readFile(path.join(registryDir, file), 'utf8'));
      if (!record || !processAlive(record.pid)) continue;
      candidates.push(record);
    } catch {
      continue;
    }
  }
  const owned = candidates
    .map((record) => ({ record, distance: ancestors.indexOf(record.pid) }))
    .filter(({ distance }) => distance >= 0)
    .sort((a, b) => a.distance - b.distance);
  return owned[0]?.record.sessionId;
}

async function ancestorPids(startPid: number): Promise<Set<number>> {
  const result = new Set<number>();
  let pid = startPid;
  for (let depth = 0; depth < 12 && pid > 1 && !result.has(pid); depth += 1) {
    result.add(pid);
    const next = await parentPid(pid);
    if (!next || next === pid) break;
    pid = next;
  }
  return result;
}

async function parentPid(pid: number): Promise<number | undefined> {
  const result = await runBoundedCommand('ps', ['-o', 'ppid=', '-p', String(pid)], 1_000, process.env);
  if (result.code !== 0) return undefined;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
