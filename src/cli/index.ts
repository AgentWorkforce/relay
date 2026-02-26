#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from './bootstrap.js';

export * from './bootstrap.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
