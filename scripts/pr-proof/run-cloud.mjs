#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { runBoundedProcess } from './process-runner.mjs';

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'success']);
const TERMINAL_FAILURE = new Set(['failed', 'cancelled', 'canceled', 'timed_out', 'error']);
const CLOUD_RUN_STATUSES = new Set([
  'pending',
  'queued',
  'launching',
  'running',
  ...TERMINAL_SUCCESS,
  ...TERMINAL_FAILURE,
]);
const LEGACY_REFRESHABLE_AUTH_KEYS = [
  'CLOUD_API_ACCESS_TOKEN',
  'CLOUD_API_REFRESH_TOKEN',
  'CLOUD_API_ACCESS_TOKEN_EXPIRES_AT',
  'CLOUD_API_REFRESH_TOKEN_EXPIRES_AT',
];
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_LIVE_OUTPUT_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const PREPARED_RUN_ID_MARKER = 'AGENT_RELAY_CLOUD_PREPARED_RUN_ID=';
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIAGNOSTIC_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const LIVE_CREDENTIAL_RE =
  /(rk_live_|rjt_live_|at_live_|nt_live_|ot_live_|cld_at_|rth_at_|ocl_node_enr_|br_)([A-Za-z0-9_%-]+(?:\.[A-Za-z0-9_%-]+)*)/g;
const STATUS_DIAGNOSTIC_FIELDS = [
  'runId',
  'status',
  'sandboxId',
  'dispatchType',
  'relayflowVersion',
  'createdAt',
  'updatedAt',
];
const STATUS_FAILURE_DIAGNOSTIC_FIELDS = ['phase', 'code', 'dispatchType', 'sandboxId', 'occurredAt'];

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

export function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    const first = output.indexOf('{');
    const last = output.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(output.slice(first, last + 1));
      } catch {
        // Fall through to the fixed error below without exposing payload excerpts.
      }
    }
    throw new Error(`${label} did not return JSON`);
  }
}

export function boundedDiagnostic(value) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_DIAGNOSTIC_BYTES) return text;

  const marker = '\n[... diagnostic output truncated ...]';
  const tailBudget = MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(marker, 'utf8');
  let tail = bytes.subarray(bytes.length - tailBudget).toString('utf8');
  // A byte slice can begin in the middle of a multi-byte code point. Removing
  // the replacement character (or another leading code point if needed) keeps
  // the final diagnostic, including its marker, within the byte contract.
  while (Buffer.byteLength(tail, 'utf8') > tailBudget) tail = tail.slice(1);
  return `${tail}${marker}`;
}

export function sanitizeCloudCommandOutput(value, secretValues = []) {
  let text = String(value ?? '');
  for (const secretValue of secretValues) {
    const secret = typeof secretValue === 'string' ? secretValue : '';
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text.replace(LIVE_CREDENTIAL_RE, (_match, prefix) => `${prefix}…`);
}

function structuralDiagnosticValue(field, value, secretValues) {
  const sanitized = sanitizeCloudCommandOutput(value, secretValues);
  if (field === 'status') return recognizedCloudRunStatus(sanitized);
  if (field === 'runId' || field === 'sandboxId') {
    return RUN_ID_RE.test(sanitized) ? sanitized : null;
  }
  if (field === 'relayflowVersion') {
    return sanitized === 'v1' || sanitized === 'v2' ? sanitized : null;
  }
  if (field === 'createdAt' || field === 'updatedAt' || field === 'occurredAt') {
    return ISO_TIMESTAMP_RE.test(sanitized) && Number.isFinite(Date.parse(sanitized)) ? sanitized : null;
  }
  return DIAGNOSTIC_TOKEN_RE.test(sanitized) ? sanitized : null;
}

function diagnosticRecord(value, secretValues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const diagnostic = {};
  for (const field of STATUS_DIAGNOSTIC_FIELDS) {
    if (typeof value[field] === 'string') {
      const structuralValue = structuralDiagnosticValue(field, value[field], secretValues);
      if (structuralValue) diagnostic[field] = structuralValue;
    }
  }
  if (value.failure && typeof value.failure === 'object' && !Array.isArray(value.failure)) {
    const failure = {};
    for (const field of STATUS_FAILURE_DIAGNOSTIC_FIELDS) {
      if (typeof value.failure[field] === 'string') {
        const structuralValue = structuralDiagnosticValue(field, value.failure[field], secretValues);
        if (structuralValue) failure[field] = structuralValue;
      }
    }
    if (Object.keys(failure).length > 0) diagnostic.failure = failure;
  }
  return diagnostic;
}

/**
 * Reduce `cloud status --json` to the structural fields useful for triage.
 * Workflow source, result payloads, nested errors, and cause chains are never
 * copied because they can contain arbitrary workflow-provided credentials.
 */
export function sanitizeCloudStatusDiagnostic(output, secretValues = []) {
  const text = String(output ?? '').trim();
  if (!text) return '';
  try {
    const payload = parseJsonOutput(text, 'Cloud status diagnostic');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return '<non-object status response omitted>';
    }
    const source =
      typeof payload.status === 'string'
        ? payload
        : payload.run && typeof payload.run === 'object' && !Array.isArray(payload.run)
          ? payload.run
          : payload.workflowRun &&
              typeof payload.workflowRun === 'object' &&
              !Array.isArray(payload.workflowRun)
            ? payload.workflowRun
            : payload;
    const diagnostic = diagnosticRecord(source, secretValues);
    return boundedDiagnostic(
      diagnostic && Object.keys(diagnostic).length > 0
        ? JSON.stringify(diagnostic)
        : '<status response omitted: no allowlisted diagnostic fields>'
    );
  } catch {
    if (text.includes('{') || text.includes('}')) {
      return '<malformed JSON status response omitted>';
    }
    return '<non-JSON status response omitted>';
  }
}

export function formatCloudRunDiagnostics({
  runId,
  terminalStatus,
  lastStatusOutput,
  statusPollFailures,
  logs,
  diagnosticSecretValues = [],
}) {
  const logOutput = `${logs?.stdout ?? ''}${logs?.stderr ?? ''}`;
  return [
    'Cloud RelayFlow diagnostics',
    `run_id=${sanitizeCloudCommandOutput(runId, diagnosticSecretValues)}`,
    `terminal_status=${sanitizeCloudCommandOutput(terminalStatus ?? 'unknown', diagnosticSecretValues)}`,
    `status_poll_failures=${statusPollFailures}`,
    `last_status_response=${
      sanitizeCloudStatusDiagnostic(lastStatusOutput, diagnosticSecretValues) || '<empty>'
    }`,
    `cloud_logs_exit_code=${logs?.exitCode ?? 'unknown'}`,
    `cloud_logs_timed_out=${logs?.timedOut === true}`,
    `cloud_logs_output=${logOutput ? 'present' : 'empty'}`,
    '',
  ].join('\n');
}

export function formatCloudRunArtifact(input) {
  return (
    formatCloudRunDiagnostics(input) +
    sanitizeCloudCommandOutput(input.logs?.stdout, input.diagnosticSecretValues) +
    sanitizeCloudCommandOutput(input.logs?.stderr, input.diagnosticSecretValues)
  );
}

export async function writeStatusPollTimeoutDiagnostics({
  logsPath,
  runId,
  lastStatusOutput,
  statusPollFailures,
  diagnosticSecretValues = [],
}) {
  await mkdir(path.dirname(logsPath), { recursive: true });
  await writeFile(
    logsPath,
    formatCloudRunDiagnostics({
      runId,
      terminalStatus: 'status_poll_timeout',
      lastStatusOutput,
      statusPollFailures,
      logs: { stdout: '', stderr: '', exitCode: 'unknown', timedOut: true },
      diagnosticSecretValues,
    })
  );
}

export function recognizedCloudRunStatus(value) {
  if (typeof value !== 'string') return null;
  const status = value.toLowerCase();
  return CLOUD_RUN_STATUSES.has(status) ? status : null;
}

function statusFrom(payload) {
  for (const candidate of [payload.status, payload.run?.status, payload.workflowRun?.status]) {
    if (typeof candidate === 'string') return recognizedCloudRunStatus(candidate);
  }
  throw new Error('Cloud status response did not contain a status');
}

export function recognizedCloudStatusFromOutput(output) {
  try {
    return statusFrom(parseJsonOutput(output, 'Cloud status'));
  } catch {
    return null;
  }
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
  return { cliEnv, diagnosticSecretValues: [apiKey] };
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
  let lastStatusOutput = '';
  let statusPollFailures = 0;

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
      console.warn(
        `Cancelling Cloud RelayFlow run ${sanitizeCloudCommandOutput(
          runId,
          auth.diagnosticSecretValues
        )} (${reason})`
      );
      const result = await run(cli, ['cloud', 'cancel', runId, '--json'], {
        env: auth.cliEnv,
        quiet: true,
        timeoutMs: commandTimeoutMs,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        console.warn(
          `Cloud cancellation failed with exit ${result.exitCode}: ${sanitizeCloudCommandOutput(
            result.stderr.trim(),
            auth.diagnosticSecretValues
          )}`
        );
      }
    })();
    await cancelPromise;
  };

  const signalHandler = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    activeCommandController?.abort();
    void (async () => {
      await cancelRemote(signal).catch((error) =>
        console.warn(sanitizeCloudCommandOutput(error.message, auth.diagnosticSecretValues))
      );
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
      process.stderr.write(sanitizeCloudCommandOutput(launch.stderr, auth.diagnosticSecretValues));
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
    console.log(`Cloud RelayFlow run: ${sanitizeCloudCommandOutput(runId, auth.diagnosticSecretValues)}`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run_id=${runId}\n`);

    const deadline = Date.now() + timeoutMs;
    let terminalStatus = null;
    while (Date.now() < deadline) {
      await delay(pollMs);
      const statusResult = await runTracked(cli, ['cloud', 'status', runId, '--json'], {
        env: auth.cliEnv,
        quiet: true,
        timeoutMs: commandTimeoutMs,
      });
      if (statusResult.timedOut) {
        statusPollFailures += 1;
        lastStatusOutput = statusResult.stderr.trim() || statusResult.stdout.trim();
        await writeStatusPollTimeoutDiagnostics({
          logsPath,
          runId,
          lastStatusOutput,
          statusPollFailures,
          diagnosticSecretValues: auth.diagnosticSecretValues,
        });
        throw new Error(`Cloud status command timed out for run ${runId}`);
      }
      if (statusResult.exitCode !== 0) {
        statusPollFailures += 1;
        lastStatusOutput = statusResult.stderr.trim() || statusResult.stdout.trim();
        console.warn(
          `Cloud status poll failed (${statusResult.exitCode}); retrying${
            lastStatusOutput
              ? `: ${sanitizeCloudStatusDiagnostic(lastStatusOutput, auth.diagnosticSecretValues)}`
              : ''
          }`
        );
        continue;
      }
      lastStatusOutput = statusResult.stdout.trim();
      const status = recognizedCloudStatusFromOutput(statusResult.stdout);
      if (!status) {
        statusPollFailures += 1;
        console.warn('Cloud RelayFlow status: <unrecognized>');
        continue;
      }
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
    const logs = await runTracked(cli, ['cloud', 'logs', runId], {
      env: auth.cliEnv,
      quiet: true,
      timeoutMs: commandTimeoutMs,
    });
    await writeFile(
      logsPath,
      formatCloudRunArtifact({
        runId,
        terminalStatus,
        lastStatusOutput,
        statusPollFailures,
        logs,
        diagnosticSecretValues: auth.diagnosticSecretValues,
      })
    );
    if (logs.stdout) {
      process.stdout.write(sanitizeCloudCommandOutput(logs.stdout, auth.diagnosticSecretValues));
    }
    if (logs.stderr) {
      process.stderr.write(sanitizeCloudCommandOutput(logs.stderr, auth.diagnosticSecretValues));
    }
    if (logs.timedOut) throw new Error(`Cloud log retrieval timed out for run ${runId}`);
    if (logs.exitCode !== 0) throw new Error(`Cloud log retrieval failed with exit ${logs.exitCode}`);

    if (!TERMINAL_SUCCESS.has(terminalStatus)) {
      throw new Error(`Cloud RelayFlow finished with status ${terminalStatus}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\n- Cloud run: \`${sanitizeCloudCommandOutput(
          runId,
          auth.diagnosticSecretValues
        )}\`\n- Cloud status: **${terminalStatus}**\n`
      );
    }
  } finally {
    activeCommandController?.abort();
    process.removeListener('SIGINT', signalHandler);
    process.removeListener('SIGTERM', signalHandler);
    if (runId && !terminal)
      await cancelRemote('dispatcher exiting').catch((error) =>
        console.warn(sanitizeCloudCommandOutput(error.message, auth.diagnosticSecretValues))
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitizeCloudCommandOutput(error.message, [process.env.CLOUD_API_KEY]));
    process.exitCode = 1;
  });
}
