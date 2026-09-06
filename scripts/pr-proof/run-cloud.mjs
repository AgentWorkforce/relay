#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { runBoundedProcess } from './process-runner.mjs';

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'cancelled', 'canceled', 'timed_out', 'error']);
const LEGACY_REFRESHABLE_AUTH_KEYS = [
  'CLOUD_API_ACCESS_TOKEN',
  'CLOUD_API_REFRESH_TOKEN',
  'CLOUD_API_ACCESS_TOKEN_EXPIRES_AT',
  'CLOUD_API_REFRESH_TOKEN_EXPIRES_AT',
];
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_LIVE_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const PREPARED_RUN_ID_MARKER = 'AGENT_RELAY_CLOUD_PREPARED_RUN_ID=';
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_TERMINAL_DIAGNOSTIC_BYTES = 32 * 1024;
// This action-facing script runs before any repository dependency install.
// Keep the credential matcher local and dependency-free so importing the
// runner cannot depend on workspace package resolution.
const LIVE_CREDENTIAL =
  /(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_|rk_live_|rjt_live_|at_live_|nt_live_|ot_live_|cld_at_|rth_at_|ocl_node_enr_|br_)([A-Za-z0-9_%-]+(?:\.[A-Za-z0-9_%-]+)*)/g;

function run(command, args, options = {}) {
  return runBoundedProcess(command, args, {
    env: options.env,
    echo: !options.quiet,
    maxCaptureBytes: MAX_CAPTURE_BYTES,
    maxLiveOutputBytes: MAX_LIVE_OUTPUT_BYTES,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
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

function statusPayloadFrom(payload) {
  for (const candidate of [payload, payload?.run, payload?.workflowRun]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      typeof candidate.status === 'string'
    ) {
      return candidate;
    }
  }
  throw new Error('Cloud status response did not contain a status');
}

function statusFrom(payload) {
  return statusPayloadFrom(payload).status.toLowerCase();
}

function truncateUtf8(value, maxBytes = 1_024) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength('…'));
  let end = contentLimit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf8')}…`;
}

function diagnosticString(value) {
  return typeof value === 'string' && value.trim() ? truncateUtf8(value.trim()) : undefined;
}

function redactTerminalDiagnostic(value, declaredSecrets) {
  // Credential-shaped values must be collapsed before arbitrary declared
  // substrings. Reversing this order can split a token and leave its tail in
  // diagnostic output.
  let redacted = value.replace(LIVE_CREDENTIAL, (match, prefix, body) =>
    declaredSecrets.includes(match)
      ? '[REDACTED_DECLARED_SECRET]'
      : body.length <= 8
        ? `${prefix}\u2026`
        : `${prefix}\u2026${body.slice(-4)}`
  );
  for (const secret of declaredSecrets) {
    redacted = redacted.split(secret).join('[REDACTED_DECLARED_SECRET]');
  }
  return redacted;
}

/**
 * Keep terminal Cloud failures useful even when the orchestrator never wrote
 * runner.log. The status route already removes its callback credential; this
 * additionally whitelists only lifecycle diagnostics, bounds them, and masks
 * both the dispatcher's exact credential and known Relay credential shapes.
 */
export function terminalStatusDiagnostic(payload, secrets = []) {
  const statusPayload = statusPayloadFrom(payload);
  const failure =
    statusPayload.failure &&
    typeof statusPayload.failure === 'object' &&
    !Array.isArray(statusPayload.failure)
      ? statusPayload.failure
      : null;
  const causeChain = Array.isArray(failure?.causeChain)
    ? failure.causeChain.map(diagnosticString).filter(Boolean).slice(0, 20)
    : undefined;
  const evidence = {
    runId: diagnosticString(statusPayload.runId ?? payload.runId),
    status: diagnosticString(statusPayload.status),
    sandboxId: diagnosticString(statusPayload.sandboxId),
    error: diagnosticString(statusPayload.error),
    ...(failure
      ? {
          failure: {
            phase: diagnosticString(failure.phase),
            code: diagnosticString(failure.code),
            message: diagnosticString(failure.message),
            causeChain,
            dispatchType: diagnosticString(failure.dispatchType),
            sandboxId: diagnosticString(failure.sandboxId),
            occurredAt: diagnosticString(failure.occurredAt),
          },
        }
      : {}),
  };

  let diagnostic = JSON.stringify(evidence, null, 2);
  const declaredSecrets = [...new Set(secrets.filter((secret) => typeof secret === 'string' && secret))].sort(
    (left, right) => right.length - left.length
  );
  diagnostic = redactTerminalDiagnostic(diagnostic, declaredSecrets);
  if (Buffer.byteLength(diagnostic, 'utf8') <= MAX_TERMINAL_DIAGNOSTIC_BYTES) return diagnostic;
  return redactTerminalDiagnostic(
    JSON.stringify(
      {
        runId: evidence.runId,
        status: evidence.status,
        error: '[TERMINAL DIAGNOSTIC OMITTED: exceeded 32768 byte evidence limit]',
      },
      null,
      2
    ),
    declaredSecrets
  );
}

function requiredCredential(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function preparedRunIdFromOutput(output) {
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(PREPARED_RUN_ID_MARKER)) continue;
    const candidate = line.slice(PREPARED_RUN_ID_MARKER.length).trim();
    if (!RUN_ID_RE.test(candidate)) {
      throw new Error('Cloud prepare progress contained an invalid run ID');
    }
    return candidate;
  }
  return null;
}

export function createPreparedRunProgressParser(onRunId) {
  let pending = '';

  const inspect = (output) => {
    for (const line of output.split(/\r?\n/)) {
      const runId = preparedRunIdFromOutput(line);
      if (runId) onRunId(runId);
    }
  };

  return {
    write(text) {
      pending += text;
      const lastNewline = pending.lastIndexOf('\n');
      if (lastNewline < 0) {
        // The marker is a short, newline-terminated trusted CLI progress line.
        // Bound unrelated unterminated stderr without parsing partial markers.
        pending = pending.slice(-8_192);
        return;
      }
      const complete = pending.slice(0, lastNewline + 1);
      pending = pending.slice(lastNewline + 1);
      inspect(complete);
    },
    end() {
      if (pending) inspect(pending);
      pending = '';
    },
  };
}

export function createCliApiKeyEnvironment(env = process.env) {
  const apiUrl = requiredCredential(env, 'CLOUD_API_URL');
  const apiKey = requiredCredential(env, 'CLOUD_API_KEY');
  new URL(apiUrl);

  const cliEnv = { ...env, CLOUD_API_URL: apiUrl, CLOUD_API_KEY: apiKey };
  for (const key of LEGACY_REFRESHABLE_AUTH_KEYS) delete cliEnv[key];
  return { cliEnv };
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
  const auth = createCliApiKeyEnvironment(process.env);
  let runId = null;
  let terminal = false;
  let cancelPromise = null;
  let shuttingDown = false;
  let activeCommandController = null;
  let launchProgressError = null;

  const notePreparedRunId = (preparedRunId) => {
    try {
      if (runId && runId !== preparedRunId) {
        throw new Error(`Cloud prepare/run ID mismatch: ${runId} != ${preparedRunId}`);
      }
      runId = preparedRunId;
    } catch (error) {
      launchProgressError ??= error;
    }
  };
  const launchProgress = createPreparedRunProgressParser(notePreparedRunId);
  const captureLaunchProgressError = (action) => {
    try {
      action();
    } catch (error) {
      launchProgressError ??= error;
    }
  };

  const runTracked = async (command, args, options = {}) => {
    const controller = new AbortController();
    activeCommandController = controller;
    try {
      return await run(command, args, { ...options, signal: controller.signal });
    } finally {
      if (activeCommandController === controller) activeCommandController = null;
    }
  };

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
    activeCommandController?.abort();
    void (async () => {
      await cancelRemote(signal).catch((error) => console.warn(error.message));
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  };
  process.once('SIGINT', signalHandler);
  process.once('SIGTERM', signalHandler);

  try {
    const launch = await runTracked(cli, ['cloud', 'run', workflowPath, '--sync-code', '--json'], {
      env: {
        ...auth.cliEnv,
        AGENT_RELAY_CLOUD_REPORT_PREPARED_RUN_ID: '1',
      },
      quiet: true,
      timeoutMs: commandTimeoutMs,
      onStderr: (text) => captureLaunchProgressError(() => launchProgress.write(text)),
    });
    captureLaunchProgressError(() => launchProgress.end());
    if (launchProgressError) throw launchProgressError;
    if (launch.aborted) throw new Error('Cloud workflow submission was interrupted');
    if (launch.timedOut) {
      await cancelRemote('submission command timed out');
      throw new Error(
        'Cloud workflow submission command timed out and its prepared run was cancelled; it is not retried'
      );
    }
    if (launch.exitCode !== 0) {
      process.stderr.write(launch.stderr);
      throw new Error(`Cloud workflow submission failed with exit ${launch.exitCode}`);
    }
    const launchPayload = parseJsonOutput(launch.stdout, 'Cloud run');
    const launchedRunId = launchPayload.runId;
    if (typeof launchedRunId !== 'string' || !RUN_ID_RE.test(launchedRunId)) {
      throw new Error('Cloud run response did not contain a valid runId');
    }
    if (runId && runId !== launchedRunId) {
      throw new Error(`Cloud prepare/run ID mismatch: ${runId} != ${launchedRunId}`);
    }
    runId = launchedRunId;
    console.log(`Cloud RelayFlow run: ${runId}`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run_id=${runId}\n`);

    const deadline = Date.now() + timeoutMs;
    let terminalStatus = null;
    let terminalPayload = null;
    while (Date.now() < deadline) {
      await delay(pollMs);
      const statusResult = await runTracked(cli, ['cloud', 'status', runId, '--json'], {
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
      const statusPayload = parseJsonOutput(statusResult.stdout, 'Cloud status');
      const status = statusFrom(statusPayload);
      console.log(`Cloud RelayFlow status: ${status}`);
      if (TERMINAL_SUCCESS.has(status) || TERMINAL_FAILURE.has(status)) {
        terminalStatus = status;
        terminalPayload = statusPayload;
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
    const logs = await runTracked(cli, ['cloud', 'logs', runId], {
      env: auth.cliEnv,
      quiet: true,
      timeoutMs: commandTimeoutMs,
    });
    const terminalDiagnostic = terminalPayload
      ? `\nCloud terminal status:\n${terminalStatusDiagnostic(terminalPayload, [auth.cliEnv.CLOUD_API_KEY])}\n`
      : '';
    await writeFile(logsPath, logs.stdout + logs.stderr + terminalDiagnostic);
    if (logs.stdout) process.stdout.write(logs.stdout);
    if (logs.stderr) process.stderr.write(logs.stderr);
    if (terminalDiagnostic) process.stderr.write(terminalDiagnostic);
    if (logs.timedOut) throw new Error(`Cloud log retrieval timed out for run ${runId}`);
    if (logs.exitCode !== 0) throw new Error(`Cloud log retrieval failed with exit ${logs.exitCode}`);

    if (!TERMINAL_SUCCESS.has(terminalStatus)) {
      throw new Error(`Cloud RelayFlow finished with status ${terminalStatus}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\n- Cloud run: \`${runId}\`\n- Cloud status: **${terminalStatus}**\n`
      );
    }
  } finally {
    activeCommandController?.abort();
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    if (runId && !terminal)
      await cancelRemote('dispatcher exiting').catch((error) => console.warn(error.message));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
