#!/usr/bin/env node

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { runBoundedProcess } from './process-runner.mjs';

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'cancelled', 'canceled', 'timed_out', 'error']);
const CLOUD_AUTH_KEYS = [
  'CLOUD_API_URL',
  'CLOUD_API_ACCESS_TOKEN',
  'CLOUD_API_REFRESH_TOKEN',
  'CLOUD_API_ACCESS_TOKEN_EXPIRES_AT',
  'CLOUD_API_REFRESH_TOKEN_EXPIRES_AT',
];
const CREDENTIAL_WINDOW_BUFFER_MS = 15 * 60_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;

function run(command, args, options = {}) {
  return runBoundedProcess(command, args, {
    env: options.env,
    echo: !options.quiet,
    maxCaptureBytes: MAX_CAPTURE_BYTES,
    timeoutMs: options.timeoutMs,
  });
}

export function boundedDuration(value, { fallback, minimum, maximum, label }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum} milliseconds`);
  }
  return parsed;
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

function requiredCredential(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function validateCredentialWindow(env, timeoutMs, now = Date.now()) {
  const accessExpiry = Date.parse(requiredCredential(env, 'CLOUD_API_ACCESS_TOKEN_EXPIRES_AT'));
  if (!Number.isFinite(accessExpiry)) throw new Error('CLOUD_API_ACCESS_TOKEN_EXPIRES_AT is invalid');
  const requiredUntil = now + timeoutMs + CREDENTIAL_WINDOW_BUFFER_MS;
  if (accessExpiry <= requiredUntil) {
    throw new Error(
      `Cloud CI access token expires before the proof deadline; reprovision the Relay secrets before ${new Date(requiredUntil).toISOString()}`
    );
  }
  const refreshExpirySource = env.CLOUD_API_REFRESH_TOKEN_EXPIRES_AT?.trim();
  if (refreshExpirySource) {
    const refreshExpiry = Date.parse(refreshExpirySource);
    if (!Number.isFinite(refreshExpiry) || refreshExpiry <= requiredUntil) {
      throw new Error('Cloud CI refresh token expires before the proof deadline; reprovision Relay secrets');
    }
  }
}

export async function createCliAuthEnvironment(env = process.env) {
  const apiUrl = requiredCredential(env, 'CLOUD_API_URL');
  const accessToken = requiredCredential(env, 'CLOUD_API_ACCESS_TOKEN');
  const refreshToken = requiredCredential(env, 'CLOUD_API_REFRESH_TOKEN');
  const accessTokenExpiresAt = requiredCredential(env, 'CLOUD_API_ACCESS_TOKEN_EXPIRES_AT');
  const refreshTokenExpiresAt = env.CLOUD_API_REFRESH_TOKEN_EXPIRES_AT?.trim();
  new URL(apiUrl);

  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'relay-pr-proof-auth-'));
  const authDir = path.join(temporaryHome, '.agentworkforce', 'relay');
  const authPath = path.join(authDir, 'cloud-auth.json');
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  await writeFile(
    authPath,
    `${JSON.stringify({
      apiUrl,
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
    })}\n`,
    { mode: 0o600 }
  );

  const cliEnv = { ...env, HOME: temporaryHome };
  for (const key of CLOUD_AUTH_KEYS) delete cliEnv[key];
  return { cliEnv, temporaryHome, authPath, originalAccessToken: accessToken };
}

export async function assertCredentialDidNotRotate(authPath, originalAccessToken) {
  const stored = JSON.parse(await readFile(authPath, 'utf8'));
  if (stored.accessToken !== originalAccessToken) {
    throw new Error(
      'Cloud CI credential refreshed during the job; the rotated tuple cannot be persisted to GitHub secrets. Reprovision the Relay secrets before rerunning.'
    );
  }
}

export async function main() {
  const cli = process.env.PR_PROOF_AGENT_RELAY_BIN ?? 'agent-relay';
  const workflowPath = process.argv[2] ?? 'workflows/pr-proof.ts';
  const logsPath = process.env.PR_PROOF_CLOUD_LOG_PATH ?? '.workflow-artifacts/pr-proof/cloud.log';
  const pollMs = boundedDuration(process.env.PR_PROOF_POLL_MS, {
    fallback: 15_000,
    minimum: 100,
    maximum: 60_000,
    label: 'PR_PROOF_POLL_MS',
  });
  const timeoutMs = boundedDuration(process.env.PR_PROOF_CLOUD_TIMEOUT_MS, {
    fallback: 60 * 60_000,
    minimum: 60_000,
    maximum: 65 * 60_000,
    label: 'PR_PROOF_CLOUD_TIMEOUT_MS',
  });
  const commandTimeoutMs = boundedDuration(process.env.PR_PROOF_CLOUD_COMMAND_TIMEOUT_MS, {
    fallback: DEFAULT_COMMAND_TIMEOUT_MS,
    minimum: 1_000,
    maximum: 5 * 60_000,
    label: 'PR_PROOF_CLOUD_COMMAND_TIMEOUT_MS',
  });
  validateCredentialWindow(process.env, timeoutMs);
  const auth = await createCliAuthEnvironment(process.env);
  let runId = null;
  let terminal = false;
  let cancelPromise = null;
  let shuttingDown = false;

  const cancelRemote = async (reason) => {
    if (!runId || terminal) return;
    cancelPromise ??= (async () => {
      console.warn(`Cancelling Cloud RelayFlow run ${runId} (${reason})`);
      const result = await run(cli, ['cloud', 'cancel', runId, '--json'], {
        env: auth.cliEnv,
        quiet: true,
        timeoutMs: commandTimeoutMs,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        console.warn(`Cloud cancellation failed with exit ${result.exitCode}: ${result.stderr.trim()}`);
      }
    })();
    await cancelPromise;
  };

  const signalHandler = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      await cancelRemote(signal).catch((error) => console.warn(error.message));
      await rm(auth.temporaryHome, { recursive: true, force: true });
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  try {
    const launch = await run(cli, ['cloud', 'run', workflowPath, '--sync-code', '--json'], {
      env: auth.cliEnv,
      quiet: true,
      timeoutMs: commandTimeoutMs,
    });
    if (launch.timedOut) {
      throw new Error(
        'Cloud workflow submission command timed out; it is not retried because submission may have completed'
      );
    }
    if (launch.exitCode !== 0) {
      process.stderr.write(launch.stderr);
      throw new Error(`Cloud workflow submission failed with exit ${launch.exitCode}`);
    }
    const launchPayload = parseJsonOutput(launch.stdout, 'Cloud run');
    runId = launchPayload.runId;
    if (typeof runId !== 'string' || !runId) throw new Error('Cloud run response did not contain runId');
    console.log(`Cloud RelayFlow run: ${runId}`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run_id=${runId}\n`);

    const deadline = Date.now() + timeoutMs;
    let terminalStatus = null;
    while (Date.now() < deadline) {
      await delay(pollMs);
      const statusResult = await run(cli, ['cloud', 'status', runId, '--json'], {
        env: auth.cliEnv,
        quiet: true,
        timeoutMs: commandTimeoutMs,
      });
      if (statusResult.timedOut) {
        throw new Error(`Cloud status command timed out for run ${runId}`);
      }
      if (statusResult.exitCode !== 0) {
        console.warn(`Cloud status poll failed (${statusResult.exitCode}); retrying`);
        continue;
      }
      const status = statusFrom(parseJsonOutput(statusResult.stdout, 'Cloud status'));
      console.log(`Cloud RelayFlow status: ${status}`);
      if (TERMINAL_SUCCESS.has(status) || TERMINAL_FAILURE.has(status)) {
        terminalStatus = status;
        terminal = true;
        break;
      }
    }
    if (!terminalStatus) {
      await cancelRemote('deadline exceeded');
      terminal = true;
      throw new Error(`Cloud RelayFlow exceeded ${timeoutMs}ms`);
    }

    await mkdir(path.dirname(logsPath), { recursive: true });
    const logs = await run(cli, ['cloud', 'logs', runId], {
      env: auth.cliEnv,
      quiet: true,
      timeoutMs: commandTimeoutMs,
    });
    await writeFile(logsPath, logs.stdout + logs.stderr);
    if (logs.stdout) process.stdout.write(logs.stdout);
    if (logs.stderr) process.stderr.write(logs.stderr);
    if (logs.timedOut) throw new Error(`Cloud log retrieval timed out for run ${runId}`);
    if (logs.exitCode !== 0) throw new Error(`Cloud log retrieval failed with exit ${logs.exitCode}`);

    if (!TERMINAL_SUCCESS.has(terminalStatus)) {
      throw new Error(`Cloud RelayFlow finished with status ${terminalStatus}`);
    }
    await assertCredentialDidNotRotate(auth.authPath, auth.originalAccessToken);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\n- Cloud run: \`${runId}\`\n- Cloud status: **${terminalStatus}**\n`
      );
    }
  } finally {
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    if (runId && !terminal)
      await cancelRemote('dispatcher exiting').catch((error) => console.warn(error.message));
    await rm(auth.temporaryHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
