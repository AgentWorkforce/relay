#!/usr/bin/env node

import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectFleetCliInventoryInProcess, inventorySha256 } from './fleet-cli-inventory.mjs';

function flag(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : (process.argv[index + 1] ?? '');
}

async function main() {
  const cli = flag('--cli');
  const output = flag('--output');
  if (!cli || !output) throw new Error('inventory worker requires --cli and --output');
  const inventory = await collectFleetCliInventoryInProcess(cli);
  const handle = await open(path.resolve(output), 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(inventory, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(`FLEET_CLI_INVENTORY_WORKER_OK sha256=${inventorySha256(inventory)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
