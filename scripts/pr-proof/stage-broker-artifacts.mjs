#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateProofInput } from './contract.mjs';

const MAX_BROKER_BYTES = 100 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readRegularFile(filePath, maxBytes) {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
      throw new Error(`${filePath} must be a regular file between 1 and ${maxBytes} bytes`);
    }
    return { handle, contents: await handle.readFile() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function inspectBrokerArtifact({ arm, expectedSha, root = process.cwd() }) {
  if (!['base', 'head'].includes(arm) || !SHA_RE.test(expectedSha)) {
    throw new Error('broker artifact arm or source SHA is invalid');
  }
  const relativeDirectory = `.relayflow/pr-proof-binaries/${arm}`;
  const binaryRelativePath = `${relativeDirectory}/agent-relay-broker`;
  const manifestPath = path.join(root, relativeDirectory, 'broker-manifest.json');
  const binaryPath = path.join(root, binaryRelativePath);

  const manifestFile = await readRegularFile(manifestPath, 16 * 1024);
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.contents.toString('utf8'));
  } finally {
    await manifestFile.handle.close();
  }
  if (manifest?.version !== 1 || manifest.sourceSha !== expectedSha) {
    throw new Error(`${arm} broker manifest does not attest exact source SHA ${expectedSha}`);
  }
  if (typeof manifest.sha256 !== 'string' || !SHA256_RE.test(manifest.sha256)) {
    throw new Error(`${arm} broker manifest SHA-256 is invalid`);
  }

  const binaryFile = await readRegularFile(binaryPath, MAX_BROKER_BYTES);
  try {
    const actualSha256 = createHash('sha256').update(binaryFile.contents).digest('hex');
    if (actualSha256 !== manifest.sha256) {
      throw new Error(`${arm} broker binary SHA-256 does not match its build manifest`);
    }
    await binaryFile.handle.chmod(0o755);
  } finally {
    await binaryFile.handle.close();
  }
  return { path: binaryRelativePath, sha256: manifest.sha256, sourceSha: expectedSha };
}

async function main() {
  const inputPath = option('--input', '.relayflow/pr-proof-input.json');
  const inputFile = await readRegularFile(inputPath, 128 * 1024);
  let rawInput;
  try {
    rawInput = JSON.parse(inputFile.contents.toString('utf8'));
  } finally {
    await inputFile.handle.close();
  }
  const base = await inspectBrokerArtifact({ arm: 'base', expectedSha: rawInput.baseSha });
  const head = await inspectBrokerArtifact({ arm: 'head', expectedSha: rawInput.headSha });
  const validated = validateProofInput({
    ...rawInput,
    runtimeArtifacts: { broker: { base, head } },
  });
  await writeFile(inputPath, `${JSON.stringify(validated, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
