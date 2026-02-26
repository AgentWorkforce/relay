#!/usr/bin/env node
import { runCurrentSdkScenario } from './utils/current-sdk-runner.js';

runCurrentSdkScenario(import.meta.url, process.argv[2]).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
