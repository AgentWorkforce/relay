import { spawn as cpSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { getCliDefinition } from '../cli-registry.js';
import { resolveCliSync } from '../cli-resolver.js';
import { runVerification } from './verification.js';
import type { AgentCli, AgentDefinition, VerificationCheck } from './types.js';

export interface SpawnOutcome {
  output: string;
  exitCode?: number;
  exitSignal?: string;
}

export interface SpawnCommand {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ShellOpts {
  cwd: string;
  timeoutMs?: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AgentOpts extends ShellOpts {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface InteractiveOpts extends ShellOpts {}

export interface ProcessSpawnerDeps {
  cwd: string;
}

export interface ProcessSpawner {
  spawnShell(command: string, opts: ShellOpts): Promise<SpawnOutcome>;
  spawnAgent(agent: AgentDefinition, task: string, opts: AgentOpts): Promise<SpawnOutcome>;
  spawnInteractive(agent: AgentDefinition, task: string, opts: InteractiveOpts): Promise<SpawnOutcome>;
  buildCommand(agent: AgentDefinition, task: string): SpawnCommand;
}

function resolveNonInteractiveCli(cli: AgentCli): AgentCli {
  if (cli !== 'cursor') {
    return cli;
  }

  const resolved = resolveCliSync('cursor');
  return (resolved?.binary as 'cursor-agent' | 'agent' | undefined) ?? 'agent';
}

export function buildCommand(cli: AgentCli, extraArgs: string[] = [], task: string): string[] {
  if (cli === 'api') {
    throw new Error('cli "api" uses direct API calls, not a subprocess command');
  }

  const resolvedCli = resolveNonInteractiveCli(cli);
  const definition = getCliDefinition(resolvedCli);
  if (!definition || definition.binaries.length === 0) {
    throw new Error(`Unknown or non-executable CLI: ${resolvedCli}`);
  }

  return [definition.binaries[0], ...definition.nonInteractiveArgs(task, extraArgs)];
}

export function spawnProcess(command: string[], options: SpawnOptions): ChildProcess {
  const [bin, ...args] = command;
  return cpSpawn(bin, args, options);
}

export function collectOutput(process: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const stdout: string[] = [];
    const stderr: string[] = [];

    process.stdout?.on('data', (chunk: Buffer | string) => {
      stdout.push(chunk.toString());
    });

    process.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.push(chunk.toString());
    });

    process.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    process.once('close', () => {
      if (!settled) {
        settled = true;
        resolve(`${stdout.join('')}${stderr.join('')}`);
      }
    });
  });
}

export function detectCompletion(output: string, verification?: VerificationCheck): boolean {
  if (/OWNER_DECISION:\s*(?:INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION)\b/i.test(output)) {
    return false;
  }

  if (/OWNER_DECISION:\s*COMPLETE\b/i.test(output)) {
    return true;
  }

  if (/\bSTEP_COMPLETE:([A-Za-z0-9_.:-]+)/.test(output)) {
    return true;
  }

  if (!verification) {
    return false;
  }

  return runVerification(verification, output, 'process', undefined, { allowFailure: true }).passed;
}

async function runCommand(command: SpawnCommand, opts: ShellOpts): Promise<SpawnOutcome> {
  const child = spawnProcess([command.bin, ...command.args], {
    cwd: opts.cwd,
    env: { ...process.env, ...command.env },
    stdio: 'pipe',
  });

  const outputPromise = collectOutput(child);
  const exitPromise = new Promise<{ exitCode?: number; exitSignal?: string }>((resolve, reject) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, opts.timeoutMs);
    }

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.once('error', (error) => {
      clearTimer();
      reject(error);
    });

    child.once('close', (exitCode, exitSignal) => {
      clearTimer();

      if (timedOut) {
        reject(new Error(`Process timed out after ${opts.timeoutMs ?? 'unknown'}ms`));
        return;
      }

      resolve({
        exitCode: exitCode ?? undefined,
        exitSignal: exitSignal ?? undefined,
      });
    });
  });

  const [output, exit] = await Promise.all([outputPromise, exitPromise]);
  return {
    output,
    exitCode: exit.exitCode,
    exitSignal: exit.exitSignal,
  };
}

export function createProcessSpawner(deps: ProcessSpawnerDeps): ProcessSpawner {
  const buildAgentCommand = (agent: AgentDefinition, task: string): SpawnCommand => {
    const extraArgs = agent.constraints?.model ? ['--model', agent.constraints.model] : [];
    const [bin, ...args] = buildCommand(agent.cli, extraArgs, task);
    return { bin, args };
  };

  return {
    async spawnShell(command, opts) {
      return runCommand({ bin: 'sh', args: ['-c', command] }, { ...opts, cwd: opts.cwd ?? deps.cwd });
    },
    async spawnAgent(agent, task, opts) {
      return runCommand(buildAgentCommand(agent, task), { ...opts, cwd: opts.cwd ?? deps.cwd });
    },
    async spawnInteractive(agent, task, opts) {
      return runCommand(buildAgentCommand(agent, task), { ...opts, cwd: opts.cwd ?? deps.cwd });
    },
    buildCommand(agent, task) {
      return buildAgentCommand(agent, task);
    },
  };
}
