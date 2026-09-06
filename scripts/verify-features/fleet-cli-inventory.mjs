#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INVENTORY_VERSION = 1;
const SAFE_JSON = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/;

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

export async function collectFleetCliInventory(cliPath) {
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

async function writePrivate(target, value) {
  const handle = await open(path.resolve(target), 'wx', 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
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
