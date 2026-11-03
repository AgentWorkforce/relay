import type { Command } from 'commander';

import { getProjectPaths } from '@agent-relay/config';
import { readStoredAuth } from '@agent-relay/cloud';

import { defaultExit } from '../lib/exit.js';

type ExitFn = (code: number) => never;

export interface StatusDependencies {
  getProjectRoot: () => string;
  getCloudAuth: () => Promise<{ apiUrl: string } | null>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withDefaults(overrides: Partial<StatusDependencies> = {}): StatusDependencies {
  return {
    getProjectRoot: () => (getProjectPaths() as { projectRoot?: string }).projectRoot ?? process.cwd(),
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
 * workspace and cloud login.
 */
export function registerStatusCommand(program: Command, overrides: Partial<StatusDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('status')
    .description('Show workspace and cloud login status')
    .action(async () => {
      deps.log(`Workspace:    ${deps.getProjectRoot()}`);

      const auth = await deps.getCloudAuth();
      deps.log(auth ? `Cloud:        logged in (${auth.apiUrl})` : 'Cloud:        not logged in');
    });
}
