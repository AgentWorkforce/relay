#!/usr/bin/env node
// The `events-shim` executable. Kept apart from cli.ts so importing the CLI
// (tests, other tools) never runs it, and so npm's bin symlink cannot skip it.
import { processIo, runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2), processIo());
