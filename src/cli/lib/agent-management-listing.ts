import path from 'node:path';

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
  readFileFrom?: (
    filePath: string,
    offset: number,
    maxBytes: number,
    encoding?: BufferEncoding
  ) => { text: string; size: number };
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  nowIso: () => string;
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

function tailLinesFromText(text: string, lineCount: number): string[] {
  const lines = text.length > 0 ? text.split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.slice(-lineCount);
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

  deps.log('NAME            STATUS   CLI       PID      UPTIME');
  deps.log('-----------------------------------------------------');
  onlineAgents.forEach((agent) => {
    deps.log(
      formatTableRow([
        { value: tableCell(agent.name, 'unknown'), width: 15 },
        { value: tableCell(agent.status), width: 8 },
        { value: tableCell(agent.cli), width: 8 },
        { value: agent.pid != null ? String(agent.pid) : '-', width: 8 },
        { value: agent.uptimeSecs != null ? formatUptimeSecs(agent.uptimeSecs) : '-' },
      ])
    );
  });
}

/**
 * Convert a raw PTY/TTY log capture into greppable, line-oriented plain text:
 * strip ANSI/cursor/control escapes, drop lines that were pure escape noise,
 * and collapse consecutive identical lines (spinner/redraw frames like
 * `⠙ Working(18m 07s)` re-printed every tick).
 */
export function toPlainLogLines(raw: string): string[] {
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
  options: { lines?: string; follow?: boolean; plain?: boolean; json?: boolean },
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
    const snapshot = readLogTail(deps, logFile, lineCount);
    const text = snapshot.text;

    // --json: machine-readable snapshot of sanitized, line-oriented output.
    // (Snapshot only — combine with the SDK event stream for live tailing.)
    if (options.json) {
      const plainLines = toPlainLogLines(text).slice(-lineCount);
      deps.log(JSON.stringify({ agent: name, file: logFile, lines: plainLines }, null, 2));
      return;
    }

    // --plain: ANSI-stripped, deduped, greppable. No decorative header so the
    // output is pure log content for piping into grep/awk.
    if (options.plain) {
      const plainLines = toPlainLogLines(text).slice(-lineCount);
      deps.log(plainLines.join('\n'));
    } else {
      const tail = tailLinesFromText(text, lineCount).map(sanitizeForTerminal).join('\n');

      deps.log(`Logs for ${sanitizeForTerminalLine(name)} (last ${lineCount} lines):`);
      deps.log('─'.repeat(50));
      deps.log(tail || '(empty)');
    }

    if (options.follow) {
      let lastSize = snapshot.size;
      let remainder = '';
      let prevStreamLine: string | undefined = options.plain
        ? toPlainLogLines(text).slice(-lineCount).at(-1)
        : undefined;

      // Poll the log file for new content every 500ms
      await new Promise<void>(() => {
        const interval = setInterval(() => {
          try {
            if (!deps.fileExists(logFile)) {
              return;
            }
            const current = readLogFrom(deps, logFile, lastSize);
            if (current.size > lastSize) {
              const newContent = remainder + current.text;
              lastSize = current.size;
              const newLines = newContent.split('\n');
              // Keep the last element as remainder (may be incomplete line)
              remainder = newLines.pop() ?? '';
              for (const line of newLines) {
                if (options.plain) {
                  const clean = sanitizeForTerminal(line).replace(/\s+$/, '');
                  if (clean === '' && line.trim() !== '') continue;
                  if (clean === prevStreamLine) continue;
                  prevStreamLine = clean;
                  deps.log(clean);
                } else {
                  deps.log(sanitizeForTerminal(line));
                }
              }
            } else if (current.size < lastSize) {
              // File was truncated/rotated, reset
              lastSize = 0;
              remainder = '';
              prevStreamLine = undefined;
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
