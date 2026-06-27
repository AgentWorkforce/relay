import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

import { Command } from 'commander';

interface ReflexState {
  enabled: boolean;
  enabledAt?: string;
}

export interface ReflexDependencies {
  fs: typeof fs;
  homedir: () => string;
  spawnSync: typeof spawnSync;
  prompt: (question: string) => Promise<boolean>;
  log: (...args: unknown[]) => void;
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

function withDefaults(overrides: Partial<ReflexDependencies> = {}): ReflexDependencies {
  return {
    fs,
    homedir: os.homedir,
    spawnSync,
    prompt: promptYesNo,
    log: (...args: unknown[]) => console.log(...args),
    ...overrides,
  };
}

function getReflexDir(deps: ReflexDependencies): string {
  return path.join(deps.homedir(), '.agentworkforce');
}

function getReflexStateFile(deps: ReflexDependencies): string {
  return path.join(getReflexDir(deps), 'reflex.json');
}

function writeReflexState(deps: ReflexDependencies, state: ReflexState): void {
  deps.fs.mkdirSync(getReflexDir(deps), { recursive: true });
  deps.fs.writeFileSync(getReflexStateFile(deps), JSON.stringify(state, null, 2), 'utf-8');
}

function readReflexState(deps: ReflexDependencies): ReflexState | null {
  const stateFile = getReflexStateFile(deps);
  if (!deps.fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(deps.fs.readFileSync(stateFile, 'utf-8')) as ReflexState;
  } catch {
    return null;
  }
}

function getSpawnErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }

  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

function isMissingBinary(error: unknown): boolean {
  return getSpawnErrorCode(error) === 'ENOENT';
}

function cloudLoginFailureMessage(error?: unknown): string {
  const code = getSpawnErrorCode(error);
  if (code) {
    return `Reflex is enabled locally, but cloud login did not complete (ai-hist failed with ${code}).`;
  }

  return 'Reflex is enabled locally, but cloud login did not complete.';
}

export function registerReflexCommands(program: Command, overrides: Partial<ReflexDependencies> = {}): void {
  const deps = withDefaults(overrides);
  const reflex = program.command('reflex').description('Manage Reflex history sync');

  reflex
    .command('on')
    .description('Enable Reflex history sync')
    .action(async () => {
      deps.log('Reflex will capture your agent sessions and sync to history.agentrelay.com');

      const accepted = await deps.prompt('Enable Reflex? (y/N) ');
      if (!accepted) {
        deps.log('Reflex was not enabled.');
        return;
      }

      writeReflexState(deps, {
        enabled: true,
        enabledAt: new Date().toISOString(),
      });

      const check = deps.spawnSync('ai-hist', ['--version'], { stdio: 'ignore' });
      if (isMissingBinary(check.error)) {
        deps.log(
          'ai-hist is not installed or not on PATH. Install it to sync Reflex history: npm install -g @agent-relay/ai-history'
        );
      } else if (check.error) {
        deps.log(cloudLoginFailureMessage(check.error));
      } else {
        const login = deps.spawnSync('ai-hist', ['login', '--cloud'], { stdio: 'inherit' });
        if (isMissingBinary(login.error)) {
          deps.log(
            'ai-hist is not installed or not on PATH. Install it to sync Reflex history: npm install -g @agent-relay/ai-history'
          );
        } else if (login.error) {
          deps.log(cloudLoginFailureMessage(login.error));
        } else if (typeof login.status === 'number' && login.status !== 0) {
          deps.log(cloudLoginFailureMessage());
        }
      }

      deps.log('Reflex is on.');
      deps.log('State file: ~/.agentworkforce/reflex.json');
    });

  reflex
    .command('off')
    .description('Disable Reflex history sync')
    .action(() => {
      writeReflexState(deps, { enabled: false });
      deps.log('Reflex is off.');
    });

  reflex
    .command('status')
    .description('Show Reflex status')
    .action(() => {
      const state = readReflexState(deps);
      if (!state) {
        deps.log('Reflex is off (never enabled).');
        return;
      }

      if (state.enabled) {
        deps.log('Reflex is on.');
        if (state.enabledAt) {
          deps.log(`Enabled at: ${state.enabledAt}`);
        }
        return;
      }

      deps.log('Reflex is off.');
      if (state.enabledAt) {
        deps.log(`Enabled at: ${state.enabledAt}`);
      }
    });
}
