#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const caseId = '2087-exact-provider-events';
const arm = process.env.RELAY_PR_PROOF_ARM;
const targetDir = process.env.RELAY_PR_PROOF_TARGET_DIR;
const resultPath = process.env.RELAY_PR_PROOF_RESULT_PATH;
const expectedSha = process.env[arm === 'base' ? 'RELAY_PR_PROOF_BASE_SHA' : 'RELAY_PR_PROOF_HEAD_SHA'];
if (!['base', 'head'].includes(arm) || !targetDir || !resultPath || !expectedSha) {
  throw new Error('RelayFlow proof environment is incomplete');
}
await rm(resultPath, { force: true });
const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetDir, encoding: 'utf8' }).trim();
if (actualSha !== expectedSha) throw new Error(`Expected ${arm} ${expectedSha}, got ${actualSha}`);

function cargo(args) {
  const result = spawnSync('cargo', ['test', '--manifest-path', 'crates/relay-node/Cargo.toml', ...args], {
    cwd: targetDir,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 12 * 60 * 1000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0 || !/test result:\s*ok\.\s+[1-9]\d*\s+passed/.test(output)) {
    throw new Error(`Runtime probe failed (${result.status})`);
  }
  return output;
}

const probePath = path.join(targetDir, 'crates/relay-node/tests/relayflow_2087_probe.rs');
await copyFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'probe.rs'), probePath);
let observation;
try {
  const output = cargo(['--test', 'relayflow_2087_probe', '--', '--nocapture']);
  const line = output.match(/PROVIDER_EVENT_FILTER_PROBE=(\{[^\n]+\})/);
  if (!line) throw new Error('Runtime probe produced no observation');
  observation = JSON.parse(line[1]);
  if (observation.retained) {
    // The public Core subscription/drain harness creates real loopback
    // subscriptions, checks persisted status, and exercises delivery admission.
    const workflow = cargo(['--test', 'relay_agents', 'integration']);
    const requiredWorkflows = [
      'integration_events_wait_for_setup_and_redrive_only_after_success',
      'rejected_integration_events_stay_excluded_after_cleanup_removes_the_filter',
      'last_integration_cleanup_keeps_queued_events_excluded_and_resubscribe_rejoins',
      'integration_events_retry_while_another_agents_setup_holds_the_lock',
    ];
    if (
      requiredWorkflows.some(
        (name) => !new RegExp(String.raw`\btest\s+(?:\w+::)*${name}\s*\.{3}\s*ok\b`).test(workflow)
      )
    ) {
      throw new Error('The filtered subscription and delivery workflows did not run');
    }
    for (const filter of [
      'event_filters',
      'integration_event',
      'integration_routing',
      'store::integration',
    ]) {
      cargo(['--lib', filter]);
    }
  }
} finally {
  await rm(probePath, { force: true });
}

const retained = observation.retained === true;
await mkdir(path.dirname(resultPath), { recursive: true });
await writeFile(
  resultPath,
  `${JSON.stringify(
    {
      version: 1,
      caseId,
      arm,
      outcome: retained ? 'fixed' : 'absent',
      signature: retained
        ? 'provider_event_filters_preserved_and_enforced'
        : 'provider_event_filters_silently_discarded',
      details: JSON.stringify(observation),
    },
    null,
    2
  )}\n`
);
