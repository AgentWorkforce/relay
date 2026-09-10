#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readRegularFileNoFollow } from './safe-file.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`--${name} is required`);
  return path.resolve(value);
}

async function collect(root, current = root, result = []) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const target = path.join(current, entry.name);
    const relative = path.relative(root, target);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`candidate evidence contains a symbolic link: ${relative}`);
    if (info.isDirectory()) await collect(root, target, result);
    else if (info.isFile()) {
      const { bytes } = await readRegularFileNoFollow(target, {
        label: `candidate evidence ${relative}`,
        maxBytes: 64 * 1024 * 1024,
      });
      result.push({ relative, bytes });
    } else throw new Error(`candidate evidence contains a non-regular entry: ${relative}`);
  }
  return result;
}

const source = option('source');
const destination = option('destination');
const files = await collect(source);
if (!files.some(({ relative }) => relative.endsWith('/evidence.json'))) {
  throw new Error('candidate evidence snapshot is missing attempt evidence');
}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true, mode: 0o700 });
const manifest = [];
for (const { relative, bytes } of files) {
  const target = path.join(destination, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
  manifest.push({ relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
await writeFile(
  path.join(destination, 'materialized-snapshot.json'),
  `${JSON.stringify({ version: 1, kind: 'fleet-daytona-untrusted-evidence-snapshot', files: manifest }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' }
);
process.stdout.write(`FLEET_EVIDENCE_MATERIALIZED files=${files.length}\n`);
