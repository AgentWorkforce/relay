import fs from 'node:fs';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { Command } from 'commander';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveProjectRoot(): string {
  // __dirname is dist/src/cli/commands/ at runtime, so go up 4 levels to project root
  // In source it's src/cli/commands/, so 3 levels up works too — check both
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '..', '..', '..', '..');
}

function resolveBrokerBinary(): string {
  const brokerExe = process.platform === 'win32' ? 'agent-relay-broker.exe' : 'agent-relay-broker';
  const root = resolveProjectRoot();

  // 1. Source checkout: Cargo release binary
  const workspaceRelease = path.join(root, 'target', 'release', brokerExe);
  if (fs.existsSync(workspaceRelease)) {
    return workspaceRelease;
  }

  // 2. Source checkout: Cargo debug binary
  const workspaceDebug = path.join(root, 'target', 'debug', brokerExe);
  if (fs.existsSync(workspaceDebug)) {
    return workspaceDebug;
  }

  // 3. Bundled broker binary in SDK package (npm install)
  const bundled = path.join(root, 'packages', 'sdk', 'bin', brokerExe);
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  // 4. Standalone broker binary from install.sh (~/.agent-relay/bin/)
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  if (homeDir) {
    const standaloneBroker = path.join(homeDir, '.agent-relay', 'bin', brokerExe);
    if (fs.existsSync(standaloneBroker)) {
      return standaloneBroker;
    }
  }

  // 5. Fall back to PATH lookup
  return brokerExe;
}

export function registerSwarmCommands(program: Command): void {
  program
    .command('swarm')
    .description('Run ad-hoc swarm execution with multiple agents')
    .option('--pattern <pattern>', 'Swarm pattern (e.g. competitive, pipeline, fan-out)', 'fan-out')
    .option('--task <task>', 'Task description for the swarm')
    .option('--teams <count>', 'Number of teams/stages to run', '2')
    .option('--timeout <duration>', 'Overall timeout (e.g. 300s, 5m, 1h)', '300s')
    .option('--cli <tool>', 'CLI tool for workers (e.g. claude, codex)', 'codex')
    .option('--list', 'List available swarm patterns')
    .option('--dry-run', 'Print execution plan without running')
    .allowUnknownOption(true)
    .action(
      async (options: {
        pattern?: string;
        task?: string;
        teams?: string;
        timeout?: string;
        cli?: string;
        list?: boolean;
        dryRun?: boolean;
      }) => {
        if (options.dryRun) {
          console.log('Swarm dry-run plan:');
          console.log(`  Pattern : ${options.pattern ?? 'fan-out'}`);
          console.log(`  Task    : ${options.task ?? '(none)'}`);
          console.log(`  Teams   : ${options.teams ?? '2'}`);
          console.log(`  Timeout : ${options.timeout ?? '300s'}`);
          console.log(`  CLI     : ${options.cli ?? 'codex'}`);
          console.log('');
          console.log('(dry-run: no broker started, no agents spawned)');
          process.exit(0);
        }

        const brokerBin = resolveBrokerBinary();
        const args: string[] = ['swarm'];

        if (options.list) {
          args.push('--list');
        } else {
          if (options.pattern) {
            args.push('--pattern', options.pattern);
          }
          if (options.task) {
            args.push('--task', options.task);
          }
          if (options.teams) {
            args.push('--teams', options.teams);
          }
          if (options.timeout) {
            args.push('--timeout', options.timeout);
          }
          if (options.cli) {
            args.push('--cli', options.cli);
          }
        }

        const child = spawnProcess(brokerBin, args, {
          cwd: process.cwd(),
          stdio: 'inherit',
          env: process.env,
        });

        const exitCode = await new Promise<number>((resolve) => {
          child.on('exit', (code) => resolve(code ?? 1));
          child.on('error', (err) => {
            console.error(`Failed to start broker: ${err.message}`);
            resolve(1);
          });
        });

        process.exit(exitCode);
      }
    );
}
