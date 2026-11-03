import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec, execFile, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command } from 'commander';

import { getProjectPaths } from '@agent-relay/config';
import { checkForUpdates } from '@agent-relay/utils';

import { runUninstallCommand, runUpdateCommand } from '../lib/core-maintenance.js';
import { defaultExit } from '../lib/exit.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

type ExitFn = (code: number) => never;

export interface CoreProjectPaths {
  projectRoot: string;
  dataDir: string;
  teamDir: string;
  dbPath?: string;
  projectId?: string;
}

export interface CoreFileSystem {
  statSync?: (
    path: string,
    options: { bigint: true }
  ) => Pick<fs.BigIntStats, 'dev' | 'ino' | 'ctimeNs' | 'mtimeNs'>;
  realpathSync?: (path: string) => string;
  lstatSync?: (path: string) => Pick<fs.Stats, 'isFile'>;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string, encoding?: BufferEncoding) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
  readdirSync: (path: string) => string[];
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  rmSync: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
  accessSync: (path: string, mode?: number) => void;
}

type UpdateInfo = {
  updateAvailable: boolean;
  latestVersion?: string;
  error?: string;
};

export interface CoreDependencies {
  getProjectPaths: () => CoreProjectPaths;
  execCommand: (command: string) => Promise<{ stdout: string; stderr: string }>;
  /** Run a program without a shell and capture its output (rejects on a non-zero exit). */
  execFileCommand: (
    file: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Run a program with inherited stdio; resolves with its exit status. */
  runInheritedCommand: (
    file: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv }
  ) => Promise<number>;
  /** GET a URL and return the body as text (rejects on a non-2xx status). */
  fetchText: (url: string) => Promise<string>;
  killProcess: (pid: number, signal?: NodeJS.Signals | number) => void;
  fs: CoreFileSystem;
  checkForUpdates: (version: string) => Promise<UpdateInfo>;
  getVersion: () => string;
  env: NodeJS.ProcessEnv;
  execPath: string;
  cliScript: string;
  pid: number;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  exit: ExitFn;
}

function findPackageJson(startDir: string, fileSystem: CoreFileSystem): string {
  let current = startDir;
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, 'package.json');
    if (fileSystem.existsSync(candidate)) {
      return candidate;
    }
    current = path.dirname(current);
  }
  throw new Error('Could not find package.json');
}

function resolveCliVersion(fileSystem: CoreFileSystem): string {
  const envVersion = process.env.AGENT_RELAY_VERSION;
  if (envVersion) {
    return envVersion;
  }

  try {
    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = findPackageJson(dirname, fileSystem);
    const packageJson = JSON.parse(fileSystem.readFileSync(packageJsonPath, 'utf-8')) as {
      version?: string;
    };
    return packageJson.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

export function withDefaults(overrides: Partial<CoreDependencies> = {}): CoreDependencies {
  const fileSystem: CoreFileSystem = overrides.fs ?? {
    realpathSync: fs.realpathSync,
    lstatSync: (filePath) => fs.lstatSync(filePath),
    existsSync: fs.existsSync,
    statSync: (filePath, options) => fs.statSync(filePath, options),
    readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
    writeFileSync: (filePath, data, encoding) => fs.writeFileSync(filePath, data, encoding),
    renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
    unlinkSync: fs.unlinkSync,
    readdirSync: (dirPath) => fs.readdirSync(dirPath),
    mkdirSync: (dirPath, options) => fs.mkdirSync(dirPath, options),
    rmSync: (targetPath, options) => fs.rmSync(targetPath, options),
    accessSync: fs.accessSync,
  };

  const defaultVersion = resolveCliVersion(fileSystem);

  return {
    getProjectPaths: () => getProjectPaths() as unknown as CoreProjectPaths,
    execCommand: async (command: string) => {
      const result = await execAsync(command);
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
    execFileCommand: async (file, args, options) => {
      const result = await execFileAsync(file, args, {
        env: options?.env,
        timeout: options?.timeoutMs,
        encoding: 'utf-8',
      });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    runInheritedCommand: (file, args, options) =>
      new Promise<number>((resolve, reject) => {
        const child = spawnProcess(file, args, { stdio: 'inherit', env: options?.env });
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
      }),
    fetchText: async (url: string) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.text();
    },
    killProcess: process.kill,
    fs: fileSystem,
    checkForUpdates: (version: string) => checkForUpdates(version) as Promise<UpdateInfo>,
    getVersion: () => defaultVersion,
    env: process.env,
    execPath: process.execPath,
    cliScript: process.argv[1] || 'dist/src/cli/index.js',
    pid: process.pid,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    exit: defaultExit,
    ...overrides,
  };
}

/**
 * Top-level maintenance verbs that manage the installed CLI itself:
 * `version`, `update`, `uninstall`.
 */
export function registerCoreMaintenance(program: Command, overrides: Partial<CoreDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('version')
    .description('Show version information')
    .action(() => {
      deps.log(`agent-relay v${deps.getVersion()}`);
    });

  program
    .command('update')
    .description('Check for updates and install if available')
    .option('--check', 'Only check for updates, do not install')
    .action(async (options: { check?: boolean }) => {
      await runUpdateCommand(options, deps);
    });

  program
    .command('uninstall')
    .description('Remove agent-relay data, configuration, and global binaries')
    .option('--keep-data', 'Keep message history and database (only remove runtime files)')
    .option('--zed', 'Also remove Zed editor configuration')
    .option('--zed-name <name>', 'Name of the Zed agent server entry to remove (default: Agent Relay)')
    .option('--snippets', 'Also remove agent-relay snippets from CLAUDE.md, GEMINI.md, AGENTS.md')
    .option('--force', 'Skip confirmation prompt')
    .option('--dry-run', 'Show what would be removed without actually removing')
    .action(
      async (options: {
        keepData?: boolean;
        zed?: boolean;
        zedName?: string;
        snippets?: boolean;
        force?: boolean;
        dryRun?: boolean;
      }) => {
        await runUninstallCommand(options, deps);
      }
    );
}
