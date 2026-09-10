#!/usr/bin/env node

import { mkdir, open, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  executeFleetCommand,
  expectedOwnedSandboxNames,
  isDaytonaDeletionAccepted,
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

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function expectedWorkspaceId(evidence, workspaceId) {
  return workspaceId ?? evidence?.environment?.expectedWorkspaceId;
}

function candidateWorkspaceId(candidate) {
  const labels = candidate?.labels;
  return [
    candidate?.cloudWorkspaceId,
    candidate?.workspaceId,
    candidate?.relayWorkspaceId,
    labels?.cloudWorkspaceId,
    labels?.workspaceId,
    labels?.relayWorkspaceId,
  ].filter((value) => typeof value === 'string' && value.trim())[0];
}

function validateRecoveredCandidate(candidate, { name, nonce, workspaceId, startedAt, baseline }) {
  if (!candidate || !UUID.test(candidate.id ?? '') || candidate.name !== name) {
    throw new Error(`exact Daytona recovery for ${name} did not return one valid sandbox`);
  }
  if (candidate.provider !== undefined && candidate.provider !== 'daytona') {
    throw new Error(`exact Daytona recovery for ${name} returned a non-Daytona sandbox`);
  }
  if (!workspaceId || candidateWorkspaceId(candidate) !== workspaceId) {
    throw new Error(
      `exact Daytona recovery for ${name} is not bound to workspace ${workspaceId ?? '(missing)'}`
    );
  }
  const startedAtMs = Date.parse(startedAt ?? '');
  const createdAtMs = Date.parse(candidate.createdAt ?? '');
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(createdAtMs) || createdAtMs < startedAtMs - 5_000) {
    throw new Error(`exact Daytona recovery for ${name} is not a new sandbox for ${nonce}`);
  }
  if (
    baseline?.sandboxIdHashes?.includes(hash(candidate.id)) ||
    baseline?.sandboxNameHashes?.includes(hash(name))
  ) {
    throw new Error(`exact Daytona recovery for ${name} matched a baseline sandbox`);
  }
  return { id: candidate.id, nodeName: name, recoveredFromLostResponse: true };
}

async function recoverMissingAttemptTargets({
  nonce,
  evidence,
  workspaceId,
  startedAt,
  baseline,
  resolveExactName,
  checkpointRecoveredTarget,
}) {
  const existingNames = new Set(
    (evidence?.resources ?? [])
      .filter(({ type }) => type === 'daytona-sandbox')
      .map(({ nodeName }) => nodeName)
  );
  const missingNames = [...expectedOwnedSandboxNames(nonce)].filter((name) => !existingNames.has(name));
  if (missingNames.length > 0 && typeof resolveExactName !== 'function') {
    throw new Error(`exact Daytona recovery is unavailable for attempt ${nonce}`);
  }
  if (missingNames.length > 0 && typeof checkpointRecoveredTarget !== 'function') {
    throw new Error(`exact Daytona recovery checkpoint is unavailable for attempt ${nonce}`);
  }
  const recovered = [];
  for (const name of missingNames) {
    const candidates = await resolveExactName({ name, nonce, workspaceId, startedAt });
    if (!Array.isArray(candidates) || candidates.length !== 1) {
      throw new Error(`exact Daytona recovery for ${name} returned ${candidates?.length ?? 0} matches`);
    }
    const target = validateRecoveredCandidate(candidates[0], {
      name,
      nonce,
      workspaceId,
      startedAt,
      baseline,
    });
    await checkpointRecoveredTarget({ nonce, target });
    recovered.push(target);
  }
  return recovered;
}

export async function reconcileExactDaytonaSandboxes({
  attempts,
  matrix,
  readAttemptEvidence,
  issueDelete,
  inspectExact,
  resolveExactName,
  checkpointRecoveredTarget,
  workspaceIds = {},
  startedAtByNonce = {},
  startedAt,
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
  const failures = [];
  for (const nonce of attempts) {
    if (!SAFE_ID.test(nonce)) throw new Error(`invalid Fleet attempt nonce: ${nonce}`);
    let evidence;
    let baseline;
    try {
      evidence = await readAttemptEvidence(nonce);
      validateRecoveryEvidence(evidence, matrix, nonce);
      baseline = evidence.baseline;
      targets.push(...exactTargets(evidence, matrix, nonce).map((target) => ({ ...target, nonce })));
    } catch (error) {
      failures.push({
        nonce,
        phase: 'evidence',
        error: String(error instanceof Error ? error.message : error),
      });
    }
    try {
      const recovered = await recoverMissingAttemptTargets({
        nonce,
        evidence,
        workspaceId: expectedWorkspaceId(evidence, workspaceIds[nonce]),
        startedAt: startedAtByNonce[nonce] ?? evidence?.startedAt ?? startedAt,
        baseline,
        resolveExactName,
        checkpointRecoveredTarget,
      });
      targets.push(...recovered.map((target) => ({ ...target, nonce })));
    } catch (error) {
      failures.push({
        nonce,
        phase: 'lost-response-recovery',
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }
  const ids = new Set();
  const uniqueTargets = [];
  for (const target of targets) {
    if (ids.has(target.id)) {
      failures.push({
        nonce: target.nonce,
        phase: 'target-identity',
        error: `a Daytona sandbox id was checkpointed by more than one Fleet attempt: ${target.id}`,
      });
      continue;
    }
    ids.add(target.id);
    uniqueTargets.push(target);
  }
  const sandboxes = await Promise.all(
    uniqueTargets.map(async (target) => {
      const targetStartedAt = now();
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
      let acceptedTombstone = false;
      let inspectionError;
      let observations = 0;
      while (Date.now() <= deadline) {
        try {
          const observed = await inspectExact(target.id);
          observations += 1;
          acceptedTombstone =
            observed !== undefined && observed !== null && isDaytonaDeletionAccepted(observed);
          if (observed === undefined || observed === null || acceptedTombstone) {
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
        startedAt: targetStartedAt,
        finishedAt: now(),
        deleteIssued: true,
        deleteExitCode: deleteResult?.exitCode ?? null,
        deleteTimedOut: deleteResult?.timedOut === true,
        absent,
        acceptedTombstone,
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
    source: 'checkpointed-or-exact-recovered-created-by-run-evidence',
    status: failures.length === 0 && sandboxes.every(({ absent }) => absent) ? 'pass' : 'fail',
    failures,
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
  const recoveryCheckpoint = `${output}.checkpoint.json`;
  const attempts = required(options, 'attempts')
    .split(',')
    .map((value) => value.trim());
  const workspaceIds = Object.fromEntries(
    attempts.map((nonce, index) => [nonce, options[`workspace-id-${index === 0 ? 'a' : 'b'}`]])
  );
  const matrix = await loadFleetMatrix(matrixPath);
  const result = await reconcileExactDaytonaSandboxes({
    attempts,
    matrix,
    workspaceIds,
    startedAt: options['started-at'] ?? process.env.FLEET_ATTEMPT_STARTED_AT,
    readAttemptEvidence: (nonce) =>
      readJson(path.join(artifactRoot, nonce, 'evidence.json'), `Fleet evidence ${nonce}`),
    issueDelete: (id, { timeoutMs }) =>
      executeFleetCommand(['daytona', 'sandbox', 'delete', id], { timeoutMs: Math.min(60_000, timeoutMs) }),
    resolveExactName: async ({ name }) => {
      const inspected = await executeFleetCommand(['daytona', 'sandbox', 'info', name, '--format', 'json'], {
        timeoutMs: 30_000,
      });
      if (isNotFound(inspected)) return [];
      if (inspected.exitCode !== 0)
        throw new Error(inspected.stderr || `exact Daytona name recovery failed for ${name}`);
      const payload = tryParseJson(inspected._rawStdout ?? inspected.stdout);
      return payload ? [payload] : [];
    },
    checkpointRecoveredTarget: async ({ nonce, target }) => {
      let checkpoint = { version: 1, kind: 'fleet-daytona-recovery-checkpoint', targets: [] };
      try {
        checkpoint = await readJson(recoveryCheckpoint, 'Fleet Daytona recovery checkpoint');
      } catch (error) {
        if (!/ENOENT|no such file/i.test(String(error))) throw error;
      }
      if (
        checkpoint.version !== 1 ||
        checkpoint.kind !== 'fleet-daytona-recovery-checkpoint' ||
        !Array.isArray(checkpoint.targets)
      ) {
        throw new Error('Fleet Daytona recovery checkpoint is invalid');
      }
      checkpoint.targets.push({ nonce, ...target });
      await writePrivateAtomic(recoveryCheckpoint, checkpoint);
    },
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
