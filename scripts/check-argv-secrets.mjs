#!/usr/bin/env node
/**
 * Guard against relay#1570: live credentials in a spawned process's argv.
 *
 * The broker configures agent CLIs through their own command lines
 * (`codex --config …`, `claude --mcp-config …`). Anything inlined there is
 * readable by every other process on the host via `ps`. This check fails
 * loudly if a credential shape ever reappears in the argv the broker builds.
 *
 *   node scripts/check-argv-secrets.mjs         # CI: drive the real spawn path
 *   node scripts/check-argv-secrets.mjs --ps    # host: scan running processes
 *
 * The CI mode is the blocking one. It feeds sentinel credentials through the
 * broker's own `mcp-args` subcommand — the same code path a real spawn uses —
 * and asserts none of them survive into argv. It also asserts the replacement
 * mechanism is present, so a guard that silently inspects nothing (an empty
 * arg list, a renamed flag) fails instead of passing vacuously.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Sentinels carry the real credential prefixes so the shape checks below are
 * genuinely exercised. Hyphens keep them clear of GitHub's push protection:
 * `rk_live_` is also Stripe's restricted-key prefix, and an unbroken run of
 * alphanumerics after it is detected as a live Stripe key.
 */
const SENTINELS = {
  apiKey: 'rk_live_argv-guard-not-a-real-api-key',
  agentToken: 'at_live_argv-guard-not-a-real-agent-token',
  workspaceKey: 'rk_live_argv-guard-not-a-real-workspace-key',
};

/** Credential shapes that must never appear in a spawned process's argv. */
const SECRET_PATTERNS = [/rk_live_[A-Za-z0-9_-]+/g, /at_live_[A-Za-z0-9_-]+/g];

const CLIS = ['codex', 'claude'];

function fail(message) {
  console.error(`\nFAIL: ${message}\n`);
  process.exitCode = 1;
}

function redact(text) {
  return text
    .replace(/rk_live_[A-Za-z0-9_-]+/g, 'rk_live_<redacted>')
    .replace(/at_live_[A-Za-z0-9_-]+/g, 'at_live_<redacted>');
}

function resolveBrokerBin() {
  const fromEnv = process.env.AGENT_RELAY_BROKER_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`AGENT_RELAY_BROKER_BIN not found: ${fromEnv}`);
    return fromEnv;
  }
  const candidates = [
    path.join(repoRoot, 'target', 'release', 'agent-relay-broker'),
    path.join(repoRoot, 'target', 'debug', 'agent-relay-broker'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `no broker binary found. Build one (cargo build -p agent-relay-broker) or set ` +
        `AGENT_RELAY_BROKER_BIN. Looked in:\n  ${candidates.join('\n  ')}`
    );
  }
  return found;
}

function mcpArgsFor(brokerBin, cli) {
  const workspacesJson = JSON.stringify([
    { api_key: SENTINELS.workspaceKey, workspace_alias: null, workspace_id: 'rw_argvguard' },
  ]);
  const stdout = execFileSync(
    brokerBin,
    [
      'mcp-args',
      '--cli', cli,
      '--agent-name', 'argv-guard',
      '--api-key', SENTINELS.apiKey,
      '--agent-token', SENTINELS.agentToken,
      '--base-url', 'https://cast.agentrelay.com',
      '--workspaces-json', workspacesJson,
      '--default-workspace', 'rw_argvguard',
      '--cwd', repoRoot,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELAY_API_KEY: '',
        RELAY_AGENT_TOKEN: '',
        // Keep the guard hermetic: preflight must not depend on a working
        // npm install of agent-relay. We are testing argv construction.
        AGENT_RELAY_MCP_COMMAND: `${process.execPath} ${path.join(repoRoot, 'scripts', 'argv-guard-stub-mcp.mjs')}`,
      },
    }
  );
  return JSON.parse(stdout);
}

function checkSpawnPath() {
  const brokerBin = resolveBrokerBin();
  console.log(`broker binary: ${brokerBin}`);

  for (const cli of CLIS) {
    let output;
    try {
      output = mcpArgsFor(brokerBin, cli);
    } catch (error) {
      fail(`[${cli}] could not compute mcp-args: ${redact(String(error.message ?? error))}`);
      continue;
    }

    const args = Array.isArray(output.args) ? output.args : [];
    const joined = args.join(' ');

    // Positive control: a guard that inspected nothing must not report success.
    if (args.length === 0) {
      fail(`[${cli}] mcp-args returned no args — the guard inspected nothing.`);
      continue;
    }
    const leaked = new Set();
    for (const pattern of SECRET_PATTERNS) {
      for (const match of joined.matchAll(pattern)) leaked.add(match[0]);
    }
    for (const sentinel of Object.values(SENTINELS)) {
      if (joined.includes(sentinel)) leaked.add(sentinel);
    }

    if (leaked.size > 0) {
      fail(
        `[${cli}] ${leaked.size} credential value(s) reached argv (relay#1570 regression).\n` +
          `  Offending args:\n` +
          args
            .filter((arg) => [...leaked].some((secret) => arg.includes(secret)))
            .map((arg) => `    ${redact(arg).slice(0, 200)}`)
            .join('\n')
      );
      continue;
    }

    // Mechanism assertion, checked only once no credential was found: it
    // distinguishes "secrets were moved out of argv" from "this build stopped
    // emitting the config at all", which would also produce a clean scan.
    if (!joined.includes('RELAY_SECRETS_FILE')) {
      fail(
        `[${cli}] no credential in argv, but also no RELAY_SECRETS_FILE reference. ` +
          `The out-of-argv mechanism is not engaged — this scan proves nothing.`
      );
      continue;
    }

    console.log(`ok   [${cli}] ${args.length} args, no credential values in argv`);
  }
}

function checkRunningProcesses() {
  const ps = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const self = process.pid;
  const offenders = ps
    .split('\n')
    .filter((line) => SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source).test(line)))
    .filter((line) => !line.includes('check-argv-secrets') && !line.includes(String(self)));

  if (offenders.length > 0) {
    const distinct = new Set();
    for (const line of offenders) {
      for (const pattern of SECRET_PATTERNS) {
        for (const match of line.matchAll(pattern)) distinct.add(match[0]);
      }
    }
    fail(
      `${offenders.length} running process(es) expose ${distinct.size} distinct credential(s) ` +
        `in argv. Rotate them and restart those processes.`
    );
    return;
  }
  console.log('ok   no running process exposes a credential in argv');
}

const psMode = process.argv.includes('--ps');
try {
  if (psMode) checkRunningProcesses();
  else checkSpawnPath();
} catch (error) {
  fail(redact(String(error?.stack ?? error)));
}

if (process.exitCode) {
  console.error('argv secret guard FAILED — see relay#1570.');
} else {
  console.log('\nargv secret guard passed.');
}
