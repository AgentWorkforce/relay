#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAiSdkSidecarMain } from '@agent-relay/harnesses';

import { runCli } from './bootstrap.js';
import { describeError } from './lib/describe-error.js';
import { exitAfterFlush } from './lib/flush-stdio.js';

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
  const main = process.argv[2] === '__ai-sdk-sidecar' ? runAiSdkSidecarMain(process.argv.slice(3)) : runCli();
  main.catch(async (err) => {
    // Commander will have already printed a helpful message for parse errors.
    // For other top-level failures, surface them to stderr and exit non-zero.
    // `describeError` keeps a non-Error rejection (e.g. `{ status: 401 }` from
    // a broker client) readable instead of collapsing it to `[object Object]`.
    process.stderr.write(`${describeError(err)}\n`);
    // Flush first: on macOS a piped stderr is asynchronous, so exiting in this
    // tick would discard the message we just wrote and leave the caller with a
    // silent non-zero exit.
    await exitAfterFlush(1);
  });
}
