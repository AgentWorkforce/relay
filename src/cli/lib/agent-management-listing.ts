import path from 'node:path';

import { formatRelativeTime, formatTableRow } from './formatting.js';
import { getWorkerLogsDir } from './paths.js';

type ExitFn = (code: number) => never;

export interface ListingWorkerInfo {
  name: string;
  runtime?: string;
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
  team?: string;
  pid?: number;
  location?: string;
  daemonId?: string;
}

interface RemoteDaemonAgentsResponse {
  allAgents: Array<{
    name: string;
    status: string;
    daemonId: string;
    daemonName: string;
  }>;
}

export interface AgentManagementListingDependencies {
  getProjectRoot: () => string;
  getDataDir: () => string;
  createClient: (cwd: string) => {
    listAgents: () => Promise<ListingWorkerInfo[]>;
    shutdown: () => Promise<unknown>;
  };
  fileExists: (filePath: string) => boolean;
  readFile: (filePath: string, encoding?: BufferEncoding) => string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  nowIso: () => string;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

const HIDDEN_LOCAL_AGENT_NAMES = new Set(['Dashboard', 'zed-bridge']);

function shouldHideLocalAgentByDefault(name: string | undefined): boolean {
  if (!name) return true;
  if (name.startsWith('__')) return true;
  return HIDDEN_LOCAL_AGENT_NAMES.has(name);
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
): Promise<RemoteDaemonAgentsResponse | undefined> {
  const response = await deps.fetch(`${config.cloudUrl}/api/daemons/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agents: [] }),
  });
  if (!response.ok) {
    return undefined;
  }

  return (await response.json()) as RemoteDaemonAgentsResponse;
}

export async function runAgentsCommand(
  options: { all?: boolean; remote?: boolean; json?: boolean },
  deps: AgentManagementListingDependencies
): Promise<void> {
  const client = deps.createClient(deps.getProjectRoot());
  const workers = await client.listAgents().catch(() => []);
  await client.shutdown().catch(() => undefined);

  const combined: CombinedAgent[] = workers
    .filter((worker) => (options.all ? true : !shouldHideLocalAgentByDefault(worker.name)))
    .map((worker) => ({
      name: worker.name || 'unknown',
      status: 'ONLINE',
      cli: worker.runtime || '-',
      team: undefined,
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
              location: agent.daemonName,
              daemonId: agent.daemonId,
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
          { value: agent.name, width: 15 },
          { value: agent.status, width: 8 },
          { value: agent.cli, width: 9 },
          { value: agent.location ?? 'local' },
        ])
      );
    });
  } else {
    deps.log('NAME            STATUS   CLI       TEAM');
    deps.log('─'.repeat(50));
    combined.forEach((agent) => {
      deps.log(
        formatTableRow([
          { value: agent.name, width: 15 },
          { value: agent.status, width: 8 },
          { value: agent.cli, width: 9 },
          { value: agent.team ?? '-' },
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
  const client = deps.createClient(deps.getProjectRoot());
  const onlineAgents = await client
    .listAgents()
    .then((list) =>
      list
        .filter((agent) => (options.all ? true : !shouldHideLocalAgentByDefault(agent.name)))
        .map((agent) => ({
          name: agent.name,
          cli: agent.runtime,
          lastSeen: deps.nowIso(),
          status: 'ONLINE',
        }))
    )
    .catch(() => []);

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

  deps.log('NAME            STATUS   CLI       LAST SEEN');
  deps.log('---------------------------------------------');
  onlineAgents.forEach((agent) => {
    deps.log(
      formatTableRow([
        { value: agent.name ?? 'unknown', width: 15 },
        { value: agent.status, width: 8 },
        { value: agent.cli ?? '-', width: 8 },
        { value: formatRelativeTime(agent.lastSeen) },
      ])
    );
  });
}

export async function runAgentsLogsCommand(
  name: string,
  options: { lines?: string; follow?: boolean },
  deps: AgentManagementListingDependencies
): Promise<void> {
  const logsDir = getWorkerLogsDir(deps.getProjectRoot());
  const logFile = path.join(logsDir, `${name}.log`);

  if (!deps.fileExists(logFile)) {
    deps.error(`No logs found for agent "${name}"`);
    deps.log(`Log file not found: ${logFile}`);
    deps.log(`Run 'agent-relay agents' to see available agents`);
    deps.exit(1);
    return;
  }

  try {
    const lineCount = Math.max(1, Number.parseInt(options.lines || '50', 10) || 50);
    const text = deps.readFile(logFile, 'utf-8');
    const lines = text.length > 0 ? text.split('\n') : [];
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    const tail = lines.slice(-lineCount).join('\n');

    deps.log(`Logs for ${name} (last ${lineCount} lines):`);
    deps.log('─'.repeat(50));
    deps.log(tail || '(empty)');

    if (options.follow) {
      let lastSize = text.length;
      let remainder = '';

      // Poll the log file for new content every 500ms
      await new Promise<void>(() => {
        const interval = setInterval(() => {
          try {
            if (!deps.fileExists(logFile)) {
              return;
            }
            const currentText = deps.readFile(logFile, 'utf-8');
            if (currentText.length > lastSize) {
              const newContent = remainder + currentText.slice(lastSize);
              lastSize = currentText.length;
              const newLines = newContent.split('\n');
              // Keep the last element as remainder (may be incomplete line)
              remainder = newLines.pop() ?? '';
              for (const line of newLines) {
                deps.log(line);
              }
            } else if (currentText.length < lastSize) {
              // File was truncated/rotated, reset
              lastSize = 0;
              remainder = '';
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
    const message = err instanceof Error ? err.message : String(err);
    deps.error(`Failed to read logs: ${message}`);
    deps.exit(1);
  }
}
