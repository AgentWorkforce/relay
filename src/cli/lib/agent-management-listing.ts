import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  formatTableRow,
  formatUptimeSecs,
  sanitizeForTerminal,
  sanitizeForTerminalLine,
} from './formatting.js';
import { getWorkerLogsDir } from './paths.js';

type ExitFn = (code: number) => never;

export interface ListingWorkerInfo {
  name: string;
  runtime?: string;
  cli?: string;
  model?: string;
  team?: string;
  pid?: number;
  last_activity_at?: string;
  context_budget_pct?: number | null;
  current_state?: 'working' | 'idle' | 'blocked_on_send';
}

interface CloudConfig {
  cloudUrl: string;
  apiKey: string;
}

interface CombinedAgent {
  name: string;
  status: string;
  cli: string;
  model?: string;
  team?: string;
  pid?: number;
  location?: string;
  brokerId?: string;
}

interface RemoteBrokerAgentsResponse {
  allAgents: Array<{
    name: string;
    status: string;
    brokerId: string;
    brokerName: string;
  }>;
}

/** Real per-agent metrics as served by the broker `/api/metrics` endpoint. */
export interface ListingAgentMetrics {
  name: string;
  pid?: number;
  memory_bytes?: number;
  uptime_secs?: number;
}

export interface ListingClient {
  listAgents: () => Promise<ListingWorkerInfo[]>;
  /**
   * Optional: fetch real broker metrics (pid / memory / uptime) so `who`
   * can report machine-readable lifecycle data instead of fabricated
   * "ONLINE / just now" placeholders.
   */
  getMetrics?: (agentName?: string) => Promise<unknown>;
  shutdown: () => Promise<unknown>;
}

export interface AgentManagementListingDependencies {
  getProjectRoot: () => string;
  getDataDir: () => string;
  createClient: (cwd: string) => ListingClient | Promise<ListingClient>;
  fileExists: (filePath: string) => boolean;
  readFile: (filePath: string, encoding?: BufferEncoding) => string;
  readFileTail?: (
    filePath: string,
    maxBytes: number,
    encoding?: BufferEncoding
  ) => { text: string; size: number };
  readFileBuffer?: (filePath: string) => Buffer;
  readFileTailBuffer?: (filePath: string, maxBytes: number) => { buffer: Buffer; size: number };
  readFileFrom?: (
    filePath: string,
    offset: number,
    maxBytes: number,
    encoding?: BufferEncoding
  ) => { text: string; size: number };
  readFileFromBuffer?: (
    filePath: string,
    offset: number,
    maxBytes: number
  ) => { buffer: Buffer; size: number };
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  nowIso: () => string;
  writeChunk: (chunk: string | Uint8Array) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

const HIDDEN_LOCAL_AGENT_NAMES = new Set(['Dashboard', 'zed-bridge']);
const MAX_LOG_LINES = 5000;
const MIN_LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_LOG_FOLLOW_BYTES = 1024 * 1024;

function tableCell(value: string | null | undefined, fallback = '-'): string {
  return sanitizeForTerminalLine(value ?? fallback);
}

function shouldHideLocalAgentByDefault(name: string | undefined): boolean {
  if (!name) return true;
  if (name.startsWith('__')) return true;
  return HIDDEN_LOCAL_AGENT_NAMES.has(name);
}

function getWorkerLogsDirCandidates(projectRoot: string): string[] {
  const preferredDir = path.join(projectRoot, '.agent-relay', 'team', 'worker-logs');
  const legacyDir = getWorkerLogsDir(projectRoot);
  return preferredDir === legacyDir ? [preferredDir] : [preferredDir, legacyDir];
}

function isSafeLogAgentName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) {
    return false;
  }
  return !trimmed.split(/[\\/]+/).some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveLogFileCandidate(logsDir: string, name: string): string | undefined {
  const base = path.resolve(logsDir);
  const candidate = path.resolve(base, `${name}.log`);
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }
  return candidate;
}

function parseLogLineCount(value: string | undefined): number {
  const raw = value ?? '50';
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid --lines value: ${raw}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LOG_LINES) {
    throw new Error(`Invalid --lines value: ${raw} (must be 1-${MAX_LOG_LINES})`);
  }
  return parsed;
}

function getTailByteLimit(lineCount: number): number {
  return Math.min(MAX_LOG_TAIL_BYTES, Math.max(MIN_LOG_TAIL_BYTES, lineCount * 4096));
}

function readLogTail(
  deps: AgentManagementListingDependencies,
  filePath: string,
  lineCount: number
): { text: string; size: number } {
  const maxBytes = getTailByteLimit(lineCount);
  if (deps.readFileTail) {
    return deps.readFileTail(filePath, maxBytes, 'utf-8');
  }
  const text = deps.readFile(filePath, 'utf-8');
  return { text, size: Buffer.byteLength(text, 'utf-8') };
}

function readLogTailBuffer(
  deps: AgentManagementListingDependencies,
  filePath: string,
  lineCount: number
): { buffer: Buffer; size: number } {
  const maxBytes = getTailByteLimit(lineCount);
  if (deps.readFileTailBuffer) {
    return deps.readFileTailBuffer(filePath, maxBytes);
  }
  if (deps.readFileBuffer) {
    const buffer = deps.readFileBuffer(filePath);
    return { buffer: buffer.subarray(Math.max(0, buffer.length - maxBytes)), size: buffer.length };
  }
  const text = deps.readFile(filePath, 'utf-8');
  const buffer = Buffer.from(text, 'utf-8');
  return { buffer: buffer.subarray(Math.max(0, buffer.length - maxBytes)), size: buffer.length };
}

function readLogFrom(
  deps: AgentManagementListingDependencies,
  filePath: string,
  offset: number
): { text: string; size: number } {
  if (deps.readFileFrom) {
    return deps.readFileFrom(filePath, offset, MAX_LOG_FOLLOW_BYTES, 'utf-8');
  }
  const text = deps.readFile(filePath, 'utf-8');
  return { text: text.slice(offset), size: text.length };
}

function readLogFromBuffer(
  deps: AgentManagementListingDependencies,
  filePath: string,
  offset: number
): { buffer: Buffer; size: number } {
  if (deps.readFileFromBuffer) {
    return deps.readFileFromBuffer(filePath, offset, MAX_LOG_FOLLOW_BYTES);
  }
  if (deps.readFileBuffer) {
    const buffer = deps.readFileBuffer(filePath);
    const start = Math.max(0, Math.min(offset, buffer.length));
    const end = Math.min(buffer.length, start + MAX_LOG_FOLLOW_BYTES);
    return { buffer: buffer.subarray(start, end), size: end };
  }
  const current = readLogFrom(deps, filePath, offset);
  return { buffer: Buffer.from(current.text, 'utf-8'), size: current.size };
}

function readCloudConfig(deps: AgentManagementListingDependencies): CloudConfig | undefined {
  const configPath = path.join(deps.getDataDir(), 'cloud-config.json');
  if (!deps.fileExists(configPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(deps.readFile(configPath, 'utf-8')) as Partial<CloudConfig>;
    if (typeof parsed.cloudUrl !== 'string' || typeof parsed.apiKey !== 'string') {
      return undefined;
    }

    return {
      cloudUrl: parsed.cloudUrl,
      apiKey: parsed.apiKey,
    };
  } catch {
    return undefined;
  }
}

async function fetchRemoteAgents(
  deps: AgentManagementListingDependencies,
  config: CloudConfig
): Promise<RemoteBrokerAgentsResponse | undefined> {
  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agents: [] }),
  };

  const response = await deps.fetch(`${config.cloudUrl}/api/brokers/agents`, requestInit);
  if (response.status === 404) {
    throw new Error(
      'BREAKING CHANGE: daemon endpoints are no longer supported. Cloud must expose /api/brokers/agents.'
    );
  }
  if (!response.ok) {
    return undefined;
  }
  return (await response.json()) as RemoteBrokerAgentsResponse;
}

export async function runAgentsCommand(
  options: { all?: boolean; remote?: boolean; json?: boolean },
  deps: AgentManagementListingDependencies
): Promise<void> {
  let client: Awaited<ReturnType<typeof deps.createClient>>;
  try {
    client = await deps.createClient(deps.getProjectRoot());
  } catch {
    if (options.json) {
      deps.log(JSON.stringify([], null, 2));
    } else {
      deps.log('No agents found. Ensure the broker is running and agents are connected.');
    }
    return;
  }
  const workers = await client.listAgents().catch(() => []);
  await client.shutdown().catch(() => undefined);

  const combined: CombinedAgent[] = workers
    .filter((worker) => (options.all ? true : !shouldHideLocalAgentByDefault(worker.name)))
    .map((worker) => ({
      name: worker.name || 'unknown',
      status: 'ONLINE',
      cli: worker.cli || worker.runtime || '-',
      model: worker.model,
      team: worker.team,
      pid: worker.pid,
      location: 'local',
    }));

  if (options.remote) {
    const config = readCloudConfig(deps);
    if (!config) {
      deps.error('[warn] Cloud not linked. Run `agent-relay cloud link` to see remote agents.');
    } else {
      try {
        const data = await fetchRemoteAgents(deps, config);
        if (data) {
          const localNames = new Set(combined.map((entry) => entry.name));
          // eslint-disable-next-line max-depth
          for (const agent of data.allAgents) {
            // eslint-disable-next-line max-depth
            if (localNames.has(agent.name)) {
              continue;
            }
            combined.push({
              name: agent.name,
              status: agent.status.toUpperCase(),
              cli: '-',
              location: agent.brokerName,
              brokerId: agent.brokerId,
            });
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        deps.error(`[warn] Failed to fetch remote agents: ${message}`);
      }
    }
  }

  if (options.json) {
    deps.log(JSON.stringify(combined, null, 2));
    return;
  }

  if (!combined.length) {
    const hint = options.all ? '' : ' (use --all to include internal/cli agents)';
    deps.log(`No agents found. Ensure the broker is running and agents are connected${hint}.`);
    return;
  }

  const hasRemote = combined.some((entry) => entry.location !== 'local');
  if (hasRemote) {
    deps.log('NAME            STATUS   CLI       LOCATION');
    deps.log('─'.repeat(55));
    combined.forEach((agent) => {
      deps.log(
        formatTableRow([
          { value: tableCell(agent.name, 'unknown'), width: 15 },
          { value: tableCell(agent.status), width: 8 },
          { value: tableCell(agent.cli), width: 9 },
          { value: tableCell(agent.location, 'local') },
        ])
      );
    });
  } else {
    deps.log('NAME            STATUS   CLI       MODEL          TEAM');
    deps.log('─'.repeat(65));
    combined.forEach((agent) => {
      deps.log(
        formatTableRow([
          { value: tableCell(agent.name, 'unknown'), width: 15 },
          { value: tableCell(agent.status), width: 8 },
          { value: tableCell(agent.cli), width: 9 },
          { value: tableCell(agent.model), width: 14 },
          { value: tableCell(agent.team) },
        ])
      );
    });
  }

  if (workers.length > 0) {
    deps.log('');
    deps.log('Commands:');
    deps.log('  agent-relay agents:logs <name>   - View spawned agent output');
    deps.log('  agent-relay agents:kill <name>   - Kill a spawned agent');
  }

  if (!options.remote) {
    deps.log('');
    deps.log('Tip: Use --remote to include agents from other linked machines.');
  }
}

export async function runWhoCommand(
  options: { all?: boolean; json?: boolean },
  deps: AgentManagementListingDependencies
): Promise<void> {
  let client: Awaited<ReturnType<typeof deps.createClient>>;
  try {
    client = await deps.createClient(deps.getProjectRoot());
  } catch {
    if (options.json) {
      deps.log(JSON.stringify([], null, 2));
    } else {
      const hint = options.all ? '' : ' (use --all to include internal/cli agents)';
      deps.log(`No active agents found${hint}.`);
    }
    return;
  }
  // Real per-agent metrics from the broker (pid / memory / uptime). This
  // replaces the previous fabricated `status: 'ONLINE'` + `lastSeen: now()`
  // placeholders so an orchestrator can poll a machine-readable lifecycle
  // signal instead of scraping the agent TTY.
  let metricsByName = new Map<string, ListingAgentMetrics>();
  if (typeof client.getMetrics === 'function') {
    try {
      const raw = (await client.getMetrics()) as { agents?: ListingAgentMetrics[] } | undefined;
      for (const m of raw?.agents ?? []) {
        if (m && typeof m.name === 'string') {
          metricsByName.set(m.name, m);
        }
      }
    } catch {
      // Metrics are best-effort enrichment — fall back to list-only data.
      metricsByName = new Map();
    }
  }

  const onlineAgents = await client
    .listAgents()
    .then((list) =>
      list
        .filter((agent) => (options.all ? true : !shouldHideLocalAgentByDefault(agent.name)))
        .map((agent) => {
          const m = metricsByName.get(agent.name);
          return {
            name: agent.name,
            cli: agent.cli || agent.runtime || null,
            // An agent present in the broker's live list is connected. We
            // do not synthesize idle/exited here — that requires broker
            // lifecycle state the CLI cannot observe without a follow-up
            // broker change.
            status: 'online' as const,
            pid: m?.pid ?? agent.pid ?? null,
            uptimeSecs: typeof m?.uptime_secs === 'number' ? m.uptime_secs : null,
            memoryBytes: typeof m?.memory_bytes === 'number' ? m.memory_bytes : null,
            lastActivity: agent.last_activity_at ?? null,
            contextBudgetPct: typeof agent.context_budget_pct === 'number' ? agent.context_budget_pct : null,
            currentState: agent.current_state ?? 'working',
          };
        })
    )
    .catch(
      () =>
        [] as Array<{
          name: string;
          cli: string | null;
          status: 'online';
          pid: number | null;
          uptimeSecs: number | null;
          memoryBytes: number | null;
          lastActivity: string | null;
          contextBudgetPct: number | null;
          currentState: 'working' | 'idle' | 'blocked_on_send';
        }>
    );

  await client.shutdown().catch(() => undefined);

  if (options.json) {
    deps.log(JSON.stringify(onlineAgents, null, 2));
    return;
  }

  if (!onlineAgents.length) {
    const hint = options.all ? '' : ' (use --all to include internal/cli agents)';
    deps.log(`No active agents found${hint}.`);
    return;
  }

  deps.log('NAME            STATUS   STATE            CLI       PID      UPTIME      CONTEXT  LAST ACTIVITY');
  deps.log('------------------------------------------------------------------------------------------');
  onlineAgents.forEach((agent) => {
    deps.log(
      formatTableRow([
        { value: tableCell(agent.name, 'unknown'), width: 15 },
        { value: tableCell(agent.status), width: 8 },
        { value: tableCell(agent.currentState), width: 16 },
        { value: tableCell(agent.cli), width: 8 },
        { value: agent.pid != null ? String(agent.pid) : '-', width: 8 },
        { value: agent.uptimeSecs != null ? formatUptimeSecs(agent.uptimeSecs) : '-', width: 11 },
        { value: agent.contextBudgetPct != null ? `${agent.contextBudgetPct}%` : '-', width: 8 },
        { value: tableCell(agent.lastActivity) },
      ])
    );
  });
}

function parseCsiParams(sequence: string): number[] {
  const numeric = sequence.replace(/[?<>=]/g, '');
  if (!numeric) return [];
  return numeric.split(';').map((part) => (part === '' ? 0 : Number(part) || 0));
}

function trimLeadingPartialCsi(raw: string): string {
  // eslint-disable-next-line no-control-regex -- scanning for an ESC/C1 CSI opener in raw PTY bytes
  const firstEscape = raw.search(/[\x1b\x9b]/);
  if (firstEscape <= 0 || firstEscape > 20) {
    return raw;
  }
  const prefix = raw.slice(0, firstEscape);
  if (prefix.includes('\n')) {
    return raw;
  }
  return /^[0-?;]*[ -/]*[@-~]$/.test(prefix) ? raw.slice(firstEscape) : raw;
}

function trailingIncompleteSequenceStart(raw: string): number | undefined {
  const csiStart = raw.lastIndexOf('\x9b');
  const escapeStart = raw.lastIndexOf('\x1b');
  const start = Math.max(csiStart, escapeStart);
  if (start < 0) return undefined;
  if (raw.slice(start).includes('\n')) return undefined;

  if (raw[start] === '\x9b') {
    for (let cursor = start + 1; cursor < raw.length; cursor += 1) {
      const code = raw.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return undefined;
    }
    return start;
  }

  const next = raw[start + 1];
  if (next === undefined) return start;
  if (next === '[') {
    for (let cursor = start + 2; cursor < raw.length; cursor += 1) {
      const code = raw.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return undefined;
    }
    return start;
  }
  if (next === ']') {
    for (let cursor = start + 2; cursor < raw.length; cursor += 1) {
      if (raw[cursor] === '\x07') return undefined;
      if (raw[cursor] === '\x1b' && raw[cursor + 1] === '\\') return undefined;
    }
    return start;
  }
  return undefined;
}

export class PtyLogCooker {
  private readonly rows = new Map<number, string[]>();
  private readonly emitted: string[] = [];
  private readonly decoder = new TextDecoder('utf-8');
  private pending = '';
  private row = 0;
  private col = 0;
  private previousEmitted: string | undefined;

  push(raw: string | Uint8Array): string[] {
    const start = this.emitted.length;
    this.replayCompleteText(this.decode(raw));
    return this.emitted.slice(start);
  }

  finish(): string[] {
    const start = this.emitted.length;
    this.replay(this.pending + this.decoder.decode());
    this.pending = '';
    this.flushScreenRows();
    return this.emitted.slice(start);
  }

  lines(): string[] {
    this.finish();
    return [...this.emitted];
  }

  private decode(raw: string | Uint8Array): string {
    return typeof raw === 'string' ? raw : this.decoder.decode(raw, { stream: true });
  }

  private replayCompleteText(raw: string): void {
    const combined = this.pending + raw;
    this.pending = '';
    const pendingStart = trailingIncompleteSequenceStart(combined);
    if (pendingStart === undefined) {
      this.replay(combined);
      return;
    }
    this.pending = combined.slice(pendingStart);
    this.replay(combined.slice(0, pendingStart));
  }

  private replay(raw: string): void {
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];

      if (char === '\x1b') {
        index = this.skipEscape(raw, index);
        continue;
      }

      if (char === '\x9b') {
        index = this.readCsi(raw, index + 1);
        continue;
      }

      if (char === '\r') {
        this.col = 0;
        continue;
      }

      if (char === '\n') {
        this.emitRow(this.row, true);
        this.rows.delete(this.row);
        this.row += 1;
        this.col = 0;
        continue;
      }

      if (char === '\b') {
        this.col = Math.max(0, this.col - 1);
        continue;
      }

      if (char === '\t') {
        const nextTab = this.col + (8 - (this.col % 8));
        while (this.col < nextTab) {
          this.writeChar(' ');
        }
        continue;
      }

      if (char === '\x07' || char < ' ' || char === '\x7f') {
        continue;
      }

      this.writeChar(char);
    }
  }

  private skipEscape(raw: string, index: number): number {
    const next = raw[index + 1];
    if (next === '[') {
      return this.readCsi(raw, index + 2);
    }
    if (next === ']') {
      return this.skipOsc(raw, index + 2);
    }
    return Math.min(raw.length - 1, index + 1);
  }

  private readCsi(raw: string, index: number): number {
    let cursor = index;
    while (cursor < raw.length) {
      const code = raw.charCodeAt(cursor);
      if (raw[cursor] === '\n' || raw[cursor] === '\r' || raw[cursor] === '\x1b') {
        return cursor - 1;
      }
      if (code >= 0x40 && code <= 0x7e) {
        this.applyCsi(raw.slice(index, cursor), raw[cursor]);
        return cursor;
      }
      cursor += 1;
    }
    return raw.length - 1;
  }

  private skipOsc(raw: string, index: number): number {
    let cursor = index;
    while (cursor < raw.length) {
      if (raw[cursor] === '\n' || raw[cursor] === '\r') {
        return cursor - 1;
      }
      if (raw[cursor] === '\x07') {
        return cursor;
      }
      if (raw[cursor] === '\x1b' && raw[cursor + 1] === '\\') {
        return cursor + 1;
      }
      cursor += 1;
    }
    return raw.length - 1;
  }

  private applyCsi(sequence: string, final: string): void {
    const params = parseCsiParams(sequence);
    const first = params[0] ?? 0;

    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - Math.max(1, first));
        break;
      case 'B':
        this.row += Math.max(1, first);
        break;
      case 'C':
        this.col += Math.max(1, first);
        break;
      case 'D':
        this.col = Math.max(0, this.col - Math.max(1, first));
        break;
      case 'E':
        this.row += Math.max(1, first);
        this.col = 0;
        break;
      case 'F':
        this.row = Math.max(0, this.row - Math.max(1, first));
        this.col = 0;
        break;
      case 'G':
        this.col = Math.max(0, Math.max(1, first) - 1);
        break;
      case 'H':
      case 'f':
        this.row = Math.max(0, Math.max(1, first || 1) - 1);
        this.col = Math.max(0, Math.max(1, params[1] ?? 1) - 1);
        break;
      case 'J':
        this.flushScreenRows();
        this.clearScreen(first);
        break;
      case 'K':
        this.clearLine(first);
        break;
      default:
        break;
    }
  }

  private currentRow(): string[] {
    const row = this.rows.get(this.row) ?? [];
    this.rows.set(this.row, row);
    return row;
  }

  private writeChar(char: string): void {
    const row = this.currentRow();
    while (row.length < this.col) {
      row.push(' ');
    }
    row[this.col] = char;
    this.col += 1;
  }

  private clearLine(mode: number): void {
    const row = this.currentRow();
    if (mode === 1) {
      for (let index = 0; index <= this.col; index += 1) {
        row[index] = ' ';
      }
      return;
    }
    if (mode === 2) {
      this.rows.set(this.row, []);
      return;
    }
    row.length = this.col;
  }

  private clearScreen(mode: number): void {
    if (mode === 1) {
      for (const row of [...this.rows.keys()].filter((key) => key <= this.row)) {
        this.rows.delete(row);
      }
      return;
    }
    if (mode === 0) {
      for (const row of [...this.rows.keys()].filter((key) => key >= this.row)) {
        this.rows.delete(row);
      }
      return;
    }
    this.rows.clear();
  }

  private flushScreenRows(): void {
    for (const row of [...this.rows.keys()].sort((a, b) => a - b)) {
      this.emitRow(row);
    }
  }

  private emitRow(rowNumber: number, preserveBlank = false): void {
    const raw = this.rows.get(rowNumber)?.join('') ?? '';
    const clean = sanitizeForTerminal(raw).replace(/\s+$/, '');
    if (
      (clean === '' && (!preserveBlank || this.previousEmitted === undefined)) ||
      clean === this.previousEmitted
    ) {
      return;
    }
    this.emitted.push(clean);
    this.previousEmitted = clean;
  }
}

/**
 * Convert a raw PTY/TTY log capture into greppable, line-oriented plain text by
 * replaying the small ANSI/VT subset used for redraws, then emitting rendered
 * rows with consecutive duplicates collapsed.
 */
export function toPlainLogLines(raw: string): string[] {
  const cooked = new PtyLogCooker();
  cooked.push(trimLeadingPartialCsi(raw));
  return cooked.lines();
}

function emitCookedLines(lines: string[], deps: AgentManagementListingDependencies): void {
  if (lines.length > 0) {
    deps.log(lines.join('\n'));
  }
}

function createCookedLogStreamer(initialText: string): {
  push: (raw: string | Uint8Array) => string[];
  reset: () => void;
} {
  let cooker = new PtyLogCooker();
  cooker.push(trimLeadingPartialCsi(initialText));
  cooker.finish();

  return {
    push: (raw: string | Uint8Array) => cooker.push(raw),
    reset: () => {
      cooker = new PtyLogCooker();
    },
  };
}

function legacySanitizedLines(raw: string): string[] {
  const out: string[] = [];
  let prev: string | undefined;
  // Drop the single file-terminating newline (its trailing '' element) so a
  // normal log file doesn't yield a spurious blank last line — same trim the
  // default view does. Interior blank lines are preserved.
  const body = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  for (const rawLine of body.split('\n')) {
    const clean = sanitizeForTerminal(rawLine).replace(/\s+$/, '');
    // A non-empty source line that sanitizes to nothing was pure escape
    // noise (cursor moves, color resets) — drop it entirely.
    if (clean === '' && rawLine.trim() !== '') continue;
    // Collapse consecutive identical lines (redraw frames / repeated blanks).
    if (clean === prev) continue;
    out.push(clean);
    prev = clean;
  }
  return out;
}

export async function runAgentsLogsCommand(
  name: string,
  options: { lines?: string; follow?: boolean; plain?: boolean; raw?: boolean; json?: boolean },
  deps: AgentManagementListingDependencies
): Promise<void> {
  if (!isSafeLogAgentName(name)) {
    deps.error(`Invalid agent name for log lookup: "${sanitizeForTerminalLine(name)}"`);
    deps.exit(1);
    return;
  }

  const logFileCandidates = getWorkerLogsDirCandidates(deps.getProjectRoot())
    .map((logsDir) => resolveLogFileCandidate(logsDir, name))
    .filter((candidate): candidate is string => Boolean(candidate));
  const logFile = logFileCandidates.find((candidate) => deps.fileExists(candidate));

  if (!logFile) {
    deps.error(`No logs found for agent "${name}"`);
    deps.log(`Checked paths:`);
    for (const candidate of logFileCandidates) {
      deps.log(`- ${candidate}`);
    }
    deps.log(`Run 'agent-relay agents' to see available agents`);
    deps.exit(1);
    return;
  }

  try {
    const lineCount = parseLogLineCount(options.lines);

    if (options.raw && options.json) {
      throw new Error('--raw cannot be combined with --json');
    }

    if (options.raw) {
      const snapshot = readLogTailBuffer(deps, logFile, lineCount);
      deps.writeChunk(snapshot.buffer);

      if (options.follow) {
        let lastSize = snapshot.size;

        await new Promise<void>(() => {
          const interval = setInterval(() => {
            try {
              if (!deps.fileExists(logFile)) {
                return;
              }
              const current = readLogFromBuffer(deps, logFile, lastSize);
              if (current.size > lastSize) {
                lastSize = current.size;
                deps.writeChunk(current.buffer);
              } else if (current.size < lastSize) {
                lastSize = 0;
              }
            } catch {
              // Ignore read errors during follow, file may be temporarily unavailable
            }
          }, 500);

          if (typeof process !== 'undefined') {
            process.on('SIGINT', () => {
              clearInterval(interval);
              process.exit(0);
            });
          }
        });
      }
      return;
    }

    const snapshot = readLogTail(deps, logFile, lineCount);
    const text = snapshot.text;

    if (options.json) {
      // --json: machine-readable snapshot of cooked, line-oriented output.
      // (Snapshot only — combine with the SDK event stream for live tailing.)
      const plainLines = toPlainLogLines(text).slice(-lineCount);
      deps.log(JSON.stringify({ agent: name, file: logFile, lines: plainLines }, null, 2));
      return;
    } else {
      // Default and --plain are both cooked and headerless so the command is
      // safe to pipe into grep/awk/jq-adjacent tooling.
      const plainLines = toPlainLogLines(text);
      const cookedLines = plainLines.length > 0 ? plainLines : legacySanitizedLines(text);
      emitCookedLines(cookedLines.slice(-lineCount), deps);
    }

    if (options.follow) {
      let lastSize = snapshot.size;
      const streamer = createCookedLogStreamer(text);

      // Poll the log file for new content every 500ms
      await new Promise<void>(() => {
        const interval = setInterval(() => {
          try {
            if (!deps.fileExists(logFile)) {
              return;
            }
            const current = readLogFromBuffer(deps, logFile, lastSize);
            if (current.size > lastSize) {
              lastSize = current.size;
              emitCookedLines(streamer.push(current.buffer), deps);
            } else if (current.size < lastSize) {
              // File was truncated/rotated, reset
              lastSize = 0;
              streamer.reset();
            }
          } catch {
            // Ignore read errors during follow, file may be temporarily unavailable
          }
        }, 500);

        // Keep the interval reference so cleanup can happen on process exit
        if (typeof process !== 'undefined') {
          process.on('SIGINT', () => {
            clearInterval(interval);
            process.exit(0);
          });
        }
      });
    }
  } catch (err: unknown) {
    const message = sanitizeForTerminalLine(err instanceof Error ? err.message : String(err));
    deps.error(`Failed to read logs: ${message}`);
    deps.exit(1);
  }
}
