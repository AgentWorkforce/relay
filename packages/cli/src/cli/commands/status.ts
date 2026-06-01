import type { Command } from 'commander';

import { getProjectPaths } from '@agent-relay/config';
import { readStoredAuth } from '@agent-relay/cloud';

import { readBrokerConnection } from '../lib/broker-lifecycle.js';
import { defaultExit } from '../lib/exit.js';

type ExitFn = (code: number) => never;

export interface StatusDependencies {
  getProjectRoot: () => string;
  getBrokerConnection: () => { url: string; apiKey?: string } | null;
  probe: (url: string) => Promise<boolean>;
  getCloudAuth: () => Promise<{ apiUrl: string } | null>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(overrides: Partial<StatusDependencies> = {}): StatusDependencies {
  return {
    getProjectRoot: () =>
      (getProjectPaths() as { projectRoot?: string }).projectRoot ?? process.cwd(),
    getBrokerConnection: () => {
      const paths = getProjectPaths() as { dataDir?: string };
      return paths.dataDir ? readBrokerConnection(paths.dataDir) : null;
    },
    probe: async (url: string) => {
      try {
        const res = await fetch(new URL('/health', url));
        return res.ok;
      } catch {
        return false;
      }
    },
    getCloudAuth: async () => {
      const auth = await readStoredAuth();
      return auth ? { apiUrl: auth.apiUrl } : null;
    },
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

/**
 * The composite top-level `relay status` — a single situational read across the
 * workspace, the local broker, and cloud login. Distinct from `relay local
 * status`, which only reports whether the broker daemon is running.
 */
export function registerStatusCommand(
  program: Command,
  overrides: Partial<StatusDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  program
    .command('status')
    .description('Show workspace, cloud login, and local broker status')
    .action(async () => {
      deps.log(`Workspace:    ${deps.getProjectRoot()}`);

      const conn = deps.getBrokerConnection();
      if (conn && (await deps.probe(conn.url))) {
        deps.log(`Local broker: running (${conn.url})`);
      } else {
        deps.log('Local broker: stopped');
      }

      const auth = await deps.getCloudAuth();
      deps.log(auth ? `Cloud:        logged in (${auth.apiUrl})` : 'Cloud:        not logged in');
    });
}
