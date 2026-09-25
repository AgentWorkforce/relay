#!/usr/bin/env node
'use strict';
// E2E env probe: records the NAMES (never the values) of relay credential-like
// environment variables this spawned worker inherited, then behaves like the
// regular stub agent so the spawn reaches harness readiness.
const { mkdirSync, renameSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const projectDir = process.env.AGENT_RELAY_PROJECT;
const agentName = process.env.RELAY_AGENT_NAME;
if (projectDir && agentName) {
  const names = Object.keys(process.env)
    .filter((name) => /^(RELAY_|AGENT_RELAY_)/.test(name))
    .filter((name) => /KEY|TOKEN|SECRET|WORKSPACES_JSON/.test(name))
    .sort();
  const dir = path.join(projectDir, '.agentworkforce', 'relay', 'e2e-env-probe');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agentName}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ agent: agentName, names }));
  renameSync(`${file}.tmp`, file);
}

require('./stub-agent.cjs');
