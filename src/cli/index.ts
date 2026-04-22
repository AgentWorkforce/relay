#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from './bootstrap.js';

export * from './bootstrap.js';

function isEntrypoint(): boolean {
  const invocationPath = process.argv[1];
  if (!invocationPath) return false;
  try {
    return fs.realpathSync(invocationPath) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(invocationPath) === fileURLToPath(import.meta.url);
  }
}

if (isEntrypoint()) {
  runCli().catch((err) => {
    // Commander will have already printed a helpful message for parse errors.
    // For other top-level failures, surface them to stderr and exit non-zero.
    const message = err instanceof Error ? err.message : String(err);
    if (message) {
      process.stderr.write(`${message}\n`);
    }
    process.exit(1);
  });
}
