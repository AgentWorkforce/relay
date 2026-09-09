#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { overwriteRegularFileNoFollow, readRegularFileNoFollow } from './safe-file.mjs';

const INVENTORY_VERSION = 1;
const SAFE_JSON = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/;
export const INVENTORY_WORKER_TIMEOUT_MS = 30_000;
const MOUNT_SANDBOX = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fleet-candidate-mount-sandbox.sh'
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function scalar(value) {
  if (value === undefined) return null;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(scalar);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, nested]) => [key, scalar(nested)])
    );
  }
  throw new Error(`CLI inventory contains unsupported ${typeof value} metadata`);
}

function commandRecord(command, names) {
  const commandPath = names.join(' ');
  return {
    path: commandPath,
    aliases: command.aliases().sort((left, right) => left.localeCompare(right, 'en')),
    hidden: command._hidden === true,
    leaf: command.commands.length === 0,
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required === true,
      variadic: argument.variadic === true,
      choices: argument.argChoices ? [...argument.argChoices].sort() : null,
      defaultValue: scalar(argument.defaultValue),
    })),
    options: command.options
      .map((option) => ({
        flags: option.flags,
        short: option.short ?? null,
        long: option.long ?? null,
        mandatory: option.mandatory === true,
        valueRequired: option.required === true,
        valueOptional: option.optional === true,
        variadic: option.variadic === true,
        negate: option.negate === true,
        hidden: option.hidden === true,
        choices: option.argChoices ? [...option.argChoices].sort() : null,
        conflictsWith: [...option.conflictsWith].sort(),
        implied: scalar(option.implied),
        envVar: option.envVar ?? null,
        defaultValue: scalar(option.defaultValue),
        presetArg: scalar(option.presetArg),
      }))
      .sort((left, right) => left.flags.localeCompare(right.flags, 'en')),
  };
}

export function inventorySha256(inventory) {
  return sha256(Buffer.from(`${JSON.stringify(inventory)}\n`));
}

export function validateFleetCliInventory(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== INVENTORY_VERSION ||
    value.kind !== 'relay-fleet-cli-inventory' ||
    !Array.isArray(value.commands) ||
    value.commands.length === 0
  ) {
    throw new Error('Fleet CLI inventory identity is invalid');
  }
  const paths = new Set();
  for (const command of value.commands) {
    if (!/^(?:fleet|node)(?: [a-z][a-z-]*)*$/.test(command?.path ?? '')) {
      throw new Error(`Fleet CLI inventory command path is invalid: ${String(command?.path)}`);
    }
    if (paths.has(command.path)) throw new Error(`duplicate Fleet CLI command ${command.path}`);
    paths.add(command.path);
    if (
      !Array.isArray(command.aliases) ||
      !Array.isArray(command.arguments) ||
      !Array.isArray(command.options)
    ) {
      throw new Error(`Fleet CLI inventory command ${command.path} is malformed`);
    }
  }
  for (const root of ['fleet', 'node']) {
    if (!paths.has(root)) throw new Error(`Fleet CLI inventory is missing ${root}`);
  }
  return value;
}

export async function collectFleetCliInventoryInProcess(cliPath) {
  const cli = path.resolve(cliPath);
  const bootstrap = path.join(path.dirname(cli), 'bootstrap.js');
  for (const [target, label] of [
    [cli, 'candidate CLI'],
    [bootstrap, 'candidate CLI bootstrap'],
  ]) {
    const info = await lstat(target);
    if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  }
  const module = await import(`${pathToFileURL(bootstrap).href}?inventory=${Date.now()}`);
  if (typeof module.createProgram !== 'function') {
    throw new Error('candidate CLI bootstrap does not export createProgram');
  }
  const program = module.createProgram({ name: 'agent-relay' });
  const commands = [];
  function visit(command, names) {
    commands.push(commandRecord(command, names));
    for (const child of command.commands) visit(child, [...names, child.name()]);
  }
  for (const rootName of ['fleet', 'node']) {
    const root = program.commands.find((command) => command.name() === rootName);
    if (!root) throw new Error(`candidate CLI does not register ${rootName}`);
    visit(root, [rootName]);
  }
  commands.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return validateFleetCliInventory({
    version: INVENTORY_VERSION,
    kind: 'relay-fleet-cli-inventory',
    commands,
  });
}

function candidateEnvironment(home) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: process.env.LANG ?? 'C',
    NO_COLOR: '1',
    CI: process.env.CI ?? '1',
    AGENT_RELAY_TELEMETRY_DISABLED: '1',
  };
}

function permissionArgs(candidateRoot, workerRoot, worker, networkBlocker, cliPath) {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('candidate CLI inventory requires a permission-capable POSIX runner');
  }
  return [
    '--permission',
    '--no-addons',
    `--allow-fs-read=${candidateRoot}`,
    `--allow-fs-read=${path.resolve(cliPath)}`,
    `--allow-fs-read=${path.join(path.dirname(path.resolve(cliPath)), 'bootstrap.js')}`,
    `--allow-fs-read=${fileURLToPath(import.meta.url)}`,
    `--allow-fs-read=${worker}`,
    `--allow-fs-read=${networkBlocker}`,
    `--allow-fs-read=${path.join(path.dirname(fileURLToPath(import.meta.url)), 'safe-file.mjs')}`,
    `--allow-fs-write=${workerRoot}`,
  ];
}

/**
 * Inspect candidate bootstrap code outside the verifier process. The worker
 * has no credential-bearing environment, no network permission, no native
 * addons, and can only write its bounded result file. Release qualification
 * additionally runs it in a Linux network and mount namespace.
 */
export async function collectFleetCliInventory(cliPath, { timeoutMs = INVENTORY_WORKER_TIMEOUT_MS } = {}) {
  const requestedCli = path.resolve(cliPath);
  const requestedRoot = path.resolve(cliPath, '..', '..', '..', '..', '..');
  for (const [target, label] of [
    [requestedCli, 'candidate CLI'],
    [path.join(path.dirname(requestedCli), 'bootstrap.js'), 'candidate CLI bootstrap'],
  ]) {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`${label} must be a non-symlink regular file`);
    }
  }
  const workerRoot = await mkdtemp(path.join(os.tmpdir(), 'relay-cli-inventory-'));
  const [candidateRoot, resolvedCli, outputRoot, worker, networkBlocker] = await Promise.all([
    realpath(requestedRoot),
    realpath(requestedCli),
    realpath(workerRoot),
    realpath(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-cli-inventory-worker.mjs')),
    realpath(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fleet-cli-network-blocker.mjs')),
  ]);
  const outputPath = path.join(outputRoot, 'inventory.json');
  const workerArgs = [
    ...permissionArgs(candidateRoot, outputRoot, worker, networkBlocker, resolvedCli),
    `--import=${networkBlocker}`,
    worker,
    '--cli',
    resolvedCli,
    '--output',
    outputPath,
  ];
  const releaseSandbox = process.env.VERIFY_FLEET_RELEASE_QUALIFICATION === '1';
  let childArgs = workerArgs;
  let childCommand = process.execPath;
  let childCwd = candidateRoot;
  if (releaseSandbox) {
    if (process.platform !== 'linux') {
      throw new Error('release qualification inventory requires a Linux network and mount namespace');
    }
    const runnerTemp = process.env.RUNNER_TEMP?.trim();
    if (!runnerTemp || !isWithin(runnerTemp, candidateRoot)) {
      throw new Error('release qualification inventory candidate root must be inside RUNNER_TEMP');
    }
    childCommand = '/usr/bin/unshare';
    childArgs = [
      '--user',
      '--map-root-user',
      '--mount',
      '--net',
      '--fork',
      '--',
      '/bin/sh',
      MOUNT_SANDBOX,
      path.resolve(runnerTemp),
      candidateRoot,
      candidateRoot,
      process.execPath,
      ...workerArgs,
    ];
    childCwd = process.cwd();
  }
  try {
    const result = await new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let timer;
      let killTimer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve(value);
      };
      const child = spawn(childCommand, childArgs, {
        cwd: childCwd,
        env: candidateEnvironment(workerRoot),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout = `${stdout}${chunk}`.slice(-4096);
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4096);
      });
      const terminate = (signal) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The child may have exited between the timeout and the signal.
        }
      };
      timer = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
        killTimer = setTimeout(() => {
          terminate('SIGKILL');
          child.stdout.destroy();
          child.stderr.destroy();
          finish({ code: null, timedOut: true, stderr, stdout });
        }, 1_500);
      }, timeoutMs);
      child.on('error', (error) => finish({ code: null, error: error.message, stderr, stdout }));
      child.on('close', (code) => finish({ code, timedOut, stderr, stdout }));
    });
    if (result.timedOut) {
      throw new Error(`candidate CLI inventory worker timed out after ${timeoutMs}ms`);
    }
    if (result.code !== 0) {
      const diagnostic = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      throw new Error(`candidate CLI inventory worker failed${diagnostic ? `: ${diagnostic}` : ''}`);
    }
    const { bytes } = await readRegularFileNoFollow(outputPath, {
      label: 'candidate CLI inventory result',
      maxBytes: 2 * 1024 * 1024,
      privateMode: true,
      currentUserOwned: true,
    });
    return validateFleetCliInventory(JSON.parse(bytes.toString('utf8')));
  } finally {
    await rm(workerRoot, { recursive: true, force: true });
  }
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function compareFleetCliInventory(actual, expected) {
  validateFleetCliInventory(actual);
  validateFleetCliInventory(expected);
  if (!isDeepStrictEqual(actual, expected)) {
    const actualPaths = new Set(actual.commands.map((command) => command.path));
    const expectedPaths = new Set(expected.commands.map((command) => command.path));
    const missing = [...expectedPaths].filter((name) => !actualPaths.has(name));
    const added = [...actualPaths].filter((name) => !expectedPaths.has(name));
    throw new Error(
      `candidate Fleet CLI inventory changed (missing=${missing.join(',') || 'none'} added=${added.join(',') || 'none'}; command options/arguments may also differ)`
    );
  }
  return actual;
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : (process.argv[index + 1] ?? '');
}

export async function writePrivate(target, value) {
  const resolved = path.resolve(target);
  try {
    const handle = await open(resolved, 'wx', 0o600);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await overwriteRegularFileNoFollow(resolved, value, {
      label: 'Fleet CLI inventory output',
      mode: 0o600,
      currentUserOwned: true,
    });
  }
}

async function main() {
  const action = process.argv[2];
  const cli = flag('--cli');
  const output = flag('--output');
  if (!['snapshot', 'verify'].includes(action) || !cli) {
    throw new Error(
      'usage: fleet-cli-inventory.mjs <snapshot|verify> --cli <index.js> [--expected <json>] [--output <json>]'
    );
  }
  const inventory = await collectFleetCliInventory(cli);
  if (action === 'verify') {
    const expectedPath = flag('--expected');
    if (!expectedPath || !SAFE_JSON.test(path.basename(expectedPath))) {
      throw new Error('verify requires a safe --expected JSON file');
    }
    const expected = JSON.parse(await readFile(path.resolve(expectedPath), 'utf8'));
    compareFleetCliInventory(inventory, expected);
  }
  const digest = inventorySha256(inventory);
  if (output) await writePrivate(output, `${JSON.stringify(inventory, null, 2)}\n`);
  process.stdout.write(
    `FLEET_CLI_INVENTORY_${action.toUpperCase()} sha256=${digest} commands=${inventory.commands.length}\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
