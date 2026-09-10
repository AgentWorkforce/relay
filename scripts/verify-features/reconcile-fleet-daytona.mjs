#!/usr/bin/env node

import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';

import {
  executeFleetCommand,
  loadFleetMatrix,
  tryParseJson,
  validateRecoveryEvidence,
} from './fleet-daytona.mjs';
import { readRegularFileNoFollow } from './safe-file.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_SLA_MS = 120_000;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

async function readJson(target, label) {
  const { bytes } = await readRegularFileNoFollow(target, {
    label,
    maxBytes: MAX_EVIDENCE_BYTES,
    privateMode: true,
    currentUserOwned: true,
  });
  return JSON.parse(bytes.toString('utf8'));
}

async function writePrivateAtomic(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}-${process.pid}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

function exactTargets(evidence, matrix, nonce) {
  validateRecoveryEvidence(evidence, matrix, nonce);
  const targets = evidence.resources
    .filter(({ type, ownership }) => type === 'daytona-sandbox' && ownership === 'created-by-run')
    .map(({ id, nodeName }) => ({ id, nodeName }));
  if (new Set(targets.map(({ id }) => id)).size !== targets.length) {
    throw new Error(`duplicate checkpointed Daytona sandbox id for ${nonce}`);
  }
  for (const target of targets) {
    if (!UUID.test(target.id)) throw new Error(`checkpointed Daytona sandbox id is invalid for ${nonce}`);
    const intent = evidence.ownershipIntents.find(
      ({ type, name }) => type === 'daytona-sandbox' && name === target.nodeName
    );
    if (
      intent?.nonce !== nonce ||
      intent?.assertedAbsentAtBaseline !== true ||
      typeof intent?.checkpointedAt !== 'string' ||
      !Number.isFinite(Date.parse(intent.checkpointedAt))
    ) {
      throw new Error(`Daytona sandbox ${target.id} lacks a valid create-step ownership checkpoint`);
    }
  }
  return targets;
}

function isNotFound(result) {
  return result.exitCode !== 0 && /not found|does not exist|404/i.test(result.stderr ?? '');
}

export async function reconcileExactDaytonaSandboxes({
  attempts,
  matrix,
  readAttemptEvidence,
  issueDelete,
  inspectExact,
  now = () => new Date().toISOString(),
  sleep = async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  slaMs = DEFAULT_SLA_MS,
  pollIntervalMs = 3_000,
}) {
  if (!Array.isArray(attempts) || attempts.length < 1)
    throw new Error('at least one Fleet attempt is required');
  if (typeof issueDelete !== 'function' || typeof inspectExact !== 'function') {
    throw new Error('exact Daytona delete and inspection functions are required');
  }
  const targets = [];
  for (const nonce of attempts) {
    if (!SAFE_ID.test(nonce)) throw new Error(`invalid Fleet attempt nonce: ${nonce}`);
    const evidence = await readAttemptEvidence(nonce);
    targets.push(...exactTargets(evidence, matrix, nonce).map((target) => ({ ...target, nonce })));
  }
  const ids = new Set();
  for (const { id } of targets) {
    if (ids.has(id)) throw new Error('a Daytona sandbox id was checkpointed by more than one Fleet attempt');
    ids.add(id);
  }
  const sandboxes = await Promise.all(
    targets.map(async (target) => {
      const startedAt = now();
      const deadline = Date.now() + slaMs;
      let deleteResult;
      let timer;
      try {
        const remainingMs = Math.max(1, deadline - Date.now());
        deleteResult = await Promise.race([
          issueDelete(target.id, { timeoutMs: remainingMs }),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ exitCode: null, timedOut: true }), remainingMs);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        deleteResult = { exitCode: null, error: String(error instanceof Error ? error.message : error) };
      } finally {
        if (timer) clearTimeout(timer);
      }
      let absent = false;
      let inspectionError;
      let observations = 0;
      while (Date.now() <= deadline) {
        try {
          const observed = await inspectExact(target.id);
          observations += 1;
          if (observed === undefined || observed === null) {
            absent = true;
            break;
          }
        } catch (error) {
          inspectionError = String(error instanceof Error ? error.message : error);
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      }
      return {
        ...target,
        startedAt,
        finishedAt: now(),
        deleteIssued: true,
        deleteExitCode: deleteResult?.exitCode ?? null,
        deleteTimedOut: deleteResult?.timedOut === true,
        absent,
        observations,
        ...(deleteResult?.error ? { deleteError: deleteResult.error } : {}),
        ...(inspectionError ? { inspectionError } : {}),
      };
    })
  );
  return {
    version: 1,
    kind: 'fleet-daytona-external-reconciliation',
    attempts,
    targetIds: sandboxes.map(({ id }) => id),
    source: 'checkpointed-created-by-run-evidence',
    status: sandboxes.every(({ absent }) => absent) ? 'pass' : 'fail',
    sandboxes,
    createdAt: now(),
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command !== 'reconcile') throw new Error('usage: reconcile ...');
  const matrixPath = path.resolve(required(options, 'matrix'));
  const artifactRoot = path.resolve(required(options, 'artifact-root'));
  const output = path.resolve(required(options, 'output'));
  const attempts = required(options, 'attempts')
    .split(',')
    .map((value) => value.trim());
  const matrix = await loadFleetMatrix(matrixPath);
  const result = await reconcileExactDaytonaSandboxes({
    attempts,
    matrix,
    readAttemptEvidence: (nonce) =>
      readJson(path.join(artifactRoot, nonce, 'evidence.json'), `Fleet evidence ${nonce}`),
    issueDelete: (id, { timeoutMs }) =>
      executeFleetCommand(['daytona', 'sandbox', 'delete', id], { timeoutMs: Math.min(60_000, timeoutMs) }),
    inspectExact: async (id) => {
      const inspected = await executeFleetCommand(['daytona', 'sandbox', 'info', id, '--format', 'json'], {
        timeoutMs: 30_000,
      });
      if (isNotFound(inspected)) return undefined;
      if (inspected.exitCode !== 0)
        throw new Error(inspected.stderr || `exact Daytona inspection failed for ${id}`);
      const payload = tryParseJson(inspected._rawStdout ?? inspected.stdout);
      if (!payload || payload.id !== id)
        throw new Error(`exact Daytona inspection returned the wrong id for ${id}`);
      return payload;
    },
  });
  await writePrivateAtomic(output, result);
  process.stdout.write(
    `FLEET_DAYTONA_EXTERNAL_RECONCILIATION status=${result.status} targets=${result.targetIds.length}\n`
  );
  if (result.status !== 'pass')
    throw new Error('exact Daytona reconciliation did not prove absence for every checkpointed sandbox');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    process.stderr.write(
      `[fleet-daytona-reconcile] ${String(error instanceof Error ? error.stack : error)}\n`
    );
    process.exitCode = 2;
  });
}
