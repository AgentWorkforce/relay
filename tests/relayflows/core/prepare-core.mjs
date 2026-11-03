// Builds the core from this checkout for scenarios when a change touches it. The
// planner only runs this step then; otherwise `relay init` installs the pinned
// release. Built as releases are, with the production feature set.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from './harness.mjs';

const crate = path.join(repoRoot, 'crates/relay-node');
execFileSync(
  'cargo',
  [
    'build',
    '--locked',
    '--no-default-features',
    '--features',
    'production-binaries',
    '--bin',
    'agent-relay-node',
  ],
  { cwd: crate, stdio: 'inherit' }
);
const target = path.join(repoRoot, '.workflow-artifacts/core/agent-relay-node');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(path.join(crate, 'target/debug/agent-relay-node'), target);
console.log(`CORE_PREPARED ${target}`);
