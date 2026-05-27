#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optionsFromEnv, startAgentRelayMcpStdio } from './agent-relay-mcp.js';

export * from './agent-relay-mcp.js';

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
  startAgentRelayMcpStdio(optionsFromEnv()).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
