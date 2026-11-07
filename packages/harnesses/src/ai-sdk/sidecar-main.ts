#!/usr/bin/env node

import { runAiSdkSidecarMain } from './sidecar.js';

runAiSdkSidecarMain().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
