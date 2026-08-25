#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'cancelled', 'canceled', 'timed_out', 'error']);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!options.quiet) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    const first = output.indexOf('{');
    const last = output.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(output.slice(first, last + 1));
    throw new Error(`${label} did not return JSON`);
  }
}

function statusFrom(payload) {
  for (const candidate of [payload.status, payload.run?.status, payload.workflowRun?.status]) {
    if (typeof candidate === 'string') return candidate.toLowerCase();
  }
  throw new Error('Cloud status response did not contain a status');
}

async function main() {
  const cli = process.env.PR_PROOF_AGENT_RELAY_BIN ?? 'agent-relay';
  const workflowPath = process.argv[2] ?? 'workflows/pr-proof.ts';
  const logsPath = process.env.PR_PROOF_CLOUD_LOG_PATH ?? '.workflow-artifacts/pr-proof/cloud.log';
  const pollMs = Number(process.env.PR_PROOF_POLL_MS ?? '15000');
  const timeoutMs = Number(process.env.PR_PROOF_CLOUD_TIMEOUT_MS ?? String(60 * 60_000));
  const launch = await run(cli, ['cloud', 'run', workflowPath, '--sync-code', '--json'], { quiet: true });
  if (launch.exitCode !== 0) {
    process.stderr.write(launch.stderr);
    throw new Error(`Cloud workflow submission failed with exit ${launch.exitCode}`);
  }
  const launchPayload = parseJsonOutput(launch.stdout, 'Cloud run');
  const runId = launchPayload.runId;
  if (typeof runId !== 'string' || !runId) throw new Error('Cloud run response did not contain runId');
  console.log(`Cloud RelayFlow run: ${runId}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run_id=${runId}\n`);

  const deadline = Date.now() + timeoutMs;
  let terminalStatus = null;
  while (Date.now() < deadline) {
    await delay(pollMs);
    const statusResult = await run(cli, ['cloud', 'status', runId, '--json'], { quiet: true });
    if (statusResult.exitCode !== 0) {
      console.warn(`Cloud status poll failed (${statusResult.exitCode}); retrying`);
      continue;
    }
    const status = statusFrom(parseJsonOutput(statusResult.stdout, 'Cloud status'));
    console.log(`Cloud RelayFlow status: ${status}`);
    if (TERMINAL_SUCCESS.has(status) || TERMINAL_FAILURE.has(status)) {
      terminalStatus = status;
      break;
    }
  }
  if (!terminalStatus) {
    await run(cli, ['cloud', 'cancel', runId], { quiet: true });
    throw new Error(`Cloud RelayFlow exceeded ${timeoutMs}ms`);
  }

  await mkdir(path.dirname(logsPath), { recursive: true });
  const logs = await run(cli, ['cloud', 'logs', runId], { quiet: true });
  await writeFile(logsPath, logs.stdout + logs.stderr);
  if (logs.stdout) process.stdout.write(logs.stdout);
  if (logs.stderr) process.stderr.write(logs.stderr);

  if (!TERMINAL_SUCCESS.has(terminalStatus)) {
    throw new Error(`Cloud RelayFlow finished with status ${terminalStatus}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `\n- Cloud run: \`${runId}\`\n- Cloud status: **${terminalStatus}**\n`
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
