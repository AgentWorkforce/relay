#!/usr/bin/env node

// Proof for #1622: a broker-served fleet node can advertise repository keys.
//
// WHAT IS OBSERVED, AND WHY IT IS THE PRODUCTION PATH
//
// `bootstrap_node_manifest` is private, so no test can call it from outside the
// crate — and a unit test that exists only on the head cannot prove the base is
// broken, because "test not found" is not an observation. So this case builds
// the broker from the TARGET checkout and runs the real binary against a
// stand-in for Relaycast's node-control endpoint, reading the `node.register`
// frame the broker actually puts on the wire.
//
// `repo_keys` is declared `skip_serializing_if = "Option::is_none"`, so the
// field is absent from that frame when the broker has nothing to advertise and
// present when it does. Both arms run the identical program with the identical
// environment; only the checkout differs.
//
// The observation is DERIVED FROM THE FRAME, never from `RELAY_PR_PROOF_ARM`.
// The arm is used solely to label the record. A head build that failed to
// advertise would report `absent` and be rejected by the gate, which is the
// point of running it.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startNodeControlObserver } from './ws-observer.mjs';

const CASE_ID = '1622-broker-node-repo-keys';
const NODE_NAME = 'relayflow-proof-1622';

// Deliberately NOT in sorted order: the head is expected to canonicalise this,
// matching `nodeRepoKeys` in packages/fleet, which returns `Object.keys(...).sort()`.
const CONFIGURED_REPOS = 'AgentWorkforce/relay,AgentWorkforce/factory';
const EXPECTED_SORTED = ['AgentWorkforce/factory', 'AgentWorkforce/relay'];

const REGISTER_TIMEOUT_MS = 120_000;

const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const caseDir = path.dirname(fileURLToPath(import.meta.url));

if ((arm !== 'base' && arm !== 'head') || !targetDir || !resultPath) {
  throw new Error('RelayFlow proof environment is incomplete');
}

const CARGO_HOME_BIN = path.join(os.homedir(), '.cargo', 'bin');

/**
 * Locate a usable cargo, installing a minimal toolchain when the host has none.
 *
 * The Cloud proof sandbox ships no Rust toolchain — the first run of this case
 * died on `spawnSync cargo ENOENT` — and the `dtolnay/rust-toolchain` action the
 * repository's own workflows use is a GitHub Action, so it cannot help inside
 * the sandbox. There is no pinned `rust-toolchain.toml`, so stable is the same
 * toolchain CI builds with.
 */
function resolveCargo() {
  for (const candidate of ['cargo', path.join(CARGO_HOME_BIN, 'cargo')]) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) {
      console.log(`[${CASE_ID}] cargo already present: ${probe.stdout.trim()}`);
      return candidate;
    }
  }

  console.log(`[${CASE_ID}] no cargo on this host; installing a minimal rustup toolchain`);
  const started = Date.now();
  const install = spawnSync(
    'bash',
    [
      '-c',
      "set -euo pipefail; curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs " +
        '| sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path',
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  process.stdout.write(install.stdout ?? '');
  process.stderr.write(install.stderr ?? '');
  if (install.error) throw install.error;
  if (install.status !== 0) {
    throw new Error(`rustup install failed with exit ${install.status}`);
  }

  const cargo = path.join(CARGO_HOME_BIN, 'cargo');
  const probe = spawnSync(cargo, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error('rustup reported success but cargo is still not runnable');
  }
  console.log(
    `[${CASE_ID}] rustup installed in ${Math.round((Date.now() - started) / 1000)}s: ${probe.stdout.trim()}`
  );
  return cargo;
}

function build(cargoBin) {
  console.log(`[${CASE_ID}] building agent-relay-broker from ${targetDir}`);
  const started = Date.now();
  const result = spawnSync(cargoBin, ['build', '-p', 'agent-relay-broker', '--bin', 'agent-relay-broker'], {
    cwd: targetDir,
    env: {
      ...process.env,
      CARGO_TERM_COLOR: 'never',
      PATH: `${CARGO_HOME_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`cargo build failed with exit ${result.status}`);
  }
  console.log(`[${CASE_ID}] build finished in ${Math.round((Date.now() - started) / 1000)}s`);
  return path.join(targetDir, 'target', 'debug', 'agent-relay-broker');
}

async function captureRegisterFrame(brokerBin) {
  const observer = startNodeControlObserver();
  const port = await observer.listening;
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `${CASE_ID}-`));
  console.log(`[${CASE_ID}] node-control observer on 127.0.0.1:${port}`);

  const child = spawn(
    brokerBin,
    [
      'init',
      '--instance-name',
      NODE_NAME,
      '--channels',
      'general',
      '--api-port',
      '0',
      '--state-dir',
      stateDir,
    ],
    {
      cwd: stateDir,
      env: {
        ...process.env,
        HOME: stateDir,
        RELAY_BASE_URL: `http://127.0.0.1:${port}`,
        RELAY_NODE_ID: 'node_relayflow_proof_1622',
        RELAY_NODE_TOKEN: 'nt_live_relayflowproof1622',
        RELAY_WORKSPACE_KEY: 'rk_live_relayflowproof1622',
        RELAY_API_KEY: 'rk_live_relayflowproof1622',
        AGENT_RELAY_WORKSPACE_KEY: 'rk_live_relayflowproof1622',
        AGENT_RELAY_NODE_HARNESSES: 'claude',
        AGENT_RELAY_NODE_REPOS: CONFIGURED_REPOS,
        AGENT_RELAY_TELEMETRY_DISABLED: '1',
        AGENT_RELAY_DATA_DIR: stateDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const brokerLog = [];
  const keep = (stream) => (chunk) => {
    const text = chunk.toString();
    brokerLog.push(text);
    process.stderr.write(text);
    void stream;
  };
  child.stdout.on('data', keep('out'));
  child.stderr.on('data', keep('err'));

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(`no node.register within ${REGISTER_TIMEOUT_MS}ms; broker exit=${JSON.stringify(exited)}`)
        ),
      REGISTER_TIMEOUT_MS
    ).unref?.()
  );

  try {
    return await Promise.race([observer.register, timeout]);
  } finally {
    child.kill('SIGKILL');
    observer.server.close();
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    if (brokerLog.length === 0) console.log(`[${CASE_ID}] broker produced no output`);
  }
}

function classify(register) {
  const advertised = Object.prototype.hasOwnProperty.call(register, 'repo_keys')
    ? register.repo_keys
    : undefined;

  if (advertised === undefined) {
    return {
      outcome: 'absent',
      signature: 'broker_node_register_omits_repo_keys',
      details:
        `The broker registered node "${register.name}" with capabilities ` +
        `[${(register.capabilities ?? []).map((c) => c.name).join(', ')}] but no repo_keys field, ` +
        `even though AGENT_RELAY_NODE_REPOS was set to "${CONFIGURED_REPOS}". ` +
        'A node that advertises no repository key cannot be selected for a repo-qualified placement.',
    };
  }

  const matches =
    Array.isArray(advertised) &&
    advertised.length === EXPECTED_SORTED.length &&
    advertised.every((value, index) => value === EXPECTED_SORTED[index]);

  if (!matches) {
    throw new Error(
      `node.register carried unexpected repo_keys ${JSON.stringify(advertised)}; expected ${JSON.stringify(EXPECTED_SORTED)}`
    );
  }

  return {
    outcome: 'fixed',
    signature: 'broker_node_register_advertises_sorted_repo_keys',
    details:
      `The broker registered node "${register.name}" advertising repo_keys ` +
      `${JSON.stringify(advertised)} from AGENT_RELAY_NODE_REPOS="${CONFIGURED_REPOS}", ` +
      'canonically sorted despite the configured order, so the node is now eligible for a repo-qualified placement.',
  };
}

const brokerBin = build(resolveCargo());
const register = await captureRegisterFrame(brokerBin);
console.log(`[${CASE_ID}] node.register: ${JSON.stringify(register)}`);
const classified = classify(register);

await writeFile(
  resultPath,
  `${JSON.stringify({ version: 1, caseId: CASE_ID, arm, ...classified }, null, 2)}\n`
);
console.log(`[${CASE_ID}] arm=${arm} outcome=${classified.outcome} signature=${classified.signature}`);
void caseDir;
