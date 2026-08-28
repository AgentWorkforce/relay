import path from 'node:path';
import { spawn } from 'node:child_process';

import type { LiveTeleportWorkspaceSource } from '@agent-relay/cloud';

import type {
  CodexMountRestoreIdentity,
  CodexPersistedMountResumeProvider,
  CodexWorkspaceSealHandle,
  CodexWorkspaceSealProvider,
} from './codex-live-controller.js';

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const FORCE_KILL_AFTER_MS = 1_000;

export type RelayfileLifecycleCommandInput = {
  binary: string;
  args: string[];
  stdin?: string;
  signal?: AbortSignal;
};

export type RelayfileLifecycleCommandRunner = (input: RelayfileLifecycleCommandInput) => Promise<unknown>;

export type RelayfileSealLifecycle = {
  checkpointAndSeal: CodexWorkspaceSealProvider;
  resumePersistedLocalMount: CodexPersistedMountResumeProvider;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`relayfile lifecycle response is missing ${field}.`);
  }
  return value.trim();
}

function requiredExactLocalRoot(value: unknown, workspaceRoot: string): string {
  const localRoot = requiredString(value, 'localRoot');
  if (
    !path.isAbsolute(localRoot) ||
    localRoot !== workspaceRoot ||
    path.resolve(localRoot) !== workspaceRoot
  ) {
    throw new Error('relayfile lifecycle response returned a mismatched local root.');
  }
  return localRoot;
}

function requiredResumeId(value: unknown): string {
  const resumeId = requiredString(value, 'resumeId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(resumeId)) {
    throw new Error('relayfile lifecycle response returned an invalid resumeId.');
  }
  return resumeId;
}

function requiredTimestamp(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`relayfile lifecycle response returned an invalid ${field}.`);
  }
  return timestamp;
}

function requiredRelayfilePosition(value: unknown, field: string, prefix: 'rev' | 'evt'): string {
  const position = requiredString(value, field);
  if (!new RegExp(`^(?:0|${prefix}_[0-9]+)$`).test(position)) {
    throw new Error(`relayfile lifecycle response returned an invalid ${field}.`);
  }
  return position;
}

function requireConvergedHealth(value: unknown): void {
  if (
    !isObject(value) ||
    value.pendingWriteback !== 0 ||
    value.conflicts !== 0 ||
    value.outboxPending !== 0 ||
    value.outboxNeedsAttention !== false
  ) {
    throw new Error('relayfile checkpoint response did not report converged health.');
  }
}

function validateReceipt(
  value: unknown,
  input: { sessionId: string; generation: number; workspaceId: string }
): JsonObject {
  if (!isObject(value)) throw new Error('relayfile checkpoint response is missing receipt.');
  const workspaceId = requiredString(value.workspaceId, 'receipt.workspaceId');
  const sessionId = requiredString(value.sessionId, 'receipt.sessionId');
  const generation = value.generation;
  const digest = requiredString(value.digest, 'receipt.digest');
  requiredString(value.sealId, 'receipt.sealId');
  requiredString(value.sealToken, 'receipt.sealToken');
  if (requiredString(value.root, 'receipt.root') !== '/') {
    throw new Error('relayfile checkpoint receipt root must be logical / for live teleport v1.');
  }
  requiredRelayfilePosition(value.workspaceRevision, 'receipt.workspaceRevision', 'rev');
  requiredRelayfilePosition(value.eventCursor, 'receipt.eventCursor', 'evt');
  requiredTimestamp(value.issuedAt, 'receipt.issuedAt');
  requiredTimestamp(value.expiresAt, 'receipt.expiresAt');
  if (
    workspaceId !== input.workspaceId ||
    sessionId !== input.sessionId ||
    generation !== input.generation ||
    !/^sha256:[a-f0-9]{64}$/.test(digest)
  ) {
    throw new Error('relayfile checkpoint receipt is unbound or has an invalid digest.');
  }
  return value;
}

function validateCheckpointOutput(
  value: unknown,
  input: { workspaceRoot: string; sessionId: string; generation: number; lifecycleId: string }
): { source: LiveTeleportWorkspaceSource; restore: CodexMountRestoreIdentity } {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.kind !== 'relayfile-checkpoint-seal' ||
    value.status !== 'sealed'
  ) {
    throw new Error('relayfile checkpoint command returned an invalid response contract.');
  }
  const workspaceId = requiredString(value.workspaceId, 'workspaceId');
  const localRoot = requiredExactLocalRoot(value.localRoot, input.workspaceRoot);
  if (
    requiredString(value.sessionId, 'sessionId') !== input.sessionId ||
    value.generation !== input.generation
  ) {
    throw new Error('relayfile checkpoint command returned a stale or cross-session response.');
  }
  requireConvergedHealth(value.health);
  requiredTimestamp(value.sealedAt, 'sealedAt');
  const resumeId = requiredResumeId(value.resumeId);
  if (resumeId !== input.lifecycleId) {
    throw new Error('relayfile checkpoint command returned a mismatched lifecycle identity.');
  }
  const receipt = validateReceipt(value.receipt, {
    sessionId: input.sessionId,
    generation: input.generation,
    workspaceId,
  });
  return {
    source: { kind: 'relayfile-checkpoint-seal', receipt },
    restore: { lifecycleId: input.lifecycleId, resumeId, workspaceId, localRoot },
  };
}

function validateResumeOutput(value: unknown, restore: CodexMountRestoreIdentity): void {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.kind !== 'relayfile-resume-seal' ||
    value.status !== 'ready'
  ) {
    throw new Error('relayfile resume command did not confirm mount readiness.');
  }
  if (
    requiredResumeId(value.resumeId) !== (restore.resumeId ?? restore.lifecycleId) ||
    (restore.workspaceId !== undefined &&
      requiredString(value.workspaceId, 'workspaceId') !== restore.workspaceId) ||
    requiredExactLocalRoot(value.localRoot, restore.localRoot) !== restore.localRoot
  ) {
    throw new Error('relayfile resume command returned a mismatched restore identity.');
  }
  requiredTimestamp(value.resumedAt, 'resumedAt');
}

function abortError(): Error {
  const error = new Error('relayfile lifecycle command was aborted.');
  error.name = 'AbortError';
  return error;
}

export const runRelayfileLifecycleJsonCommand: RelayfileLifecycleCommandRunner = async (input) => {
  if (input.signal?.aborted) throw abortError();
  const child = spawn(input.binary, input.args, { stdio: ['pipe', 'pipe', 'pipe'] });

  return new Promise<unknown>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputError: Error | undefined;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next, 'utf8') > MAX_COMMAND_OUTPUT_BYTES && !outputError) {
        outputError = new Error('relayfile lifecycle command output exceeded 1 MiB.');
        child.kill('SIGKILL');
      }
      return next.slice(-MAX_COMMAND_OUTPUT_BYTES);
    };
    const cleanup = () => {
      input.signal?.removeEventListener('abort', onAbort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_AFTER_MS);
      forceKillTimer.unref?.();
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => {
      cleanup();
      reject(new Error(`Could not start relayfile lifecycle command: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (aborted) {
        reject(abortError());
        return;
      }
      if (outputError) {
        reject(outputError);
        return;
      }
      if (code !== 0) {
        const stableCode = /(?:^|\n)error:\s*([a-z0-9_]+):/i.exec(stderr)?.[1];
        reject(
          new Error(
            `relayfile lifecycle command failed (${signal ?? `exit ${code ?? 'unknown'}`}${
              stableCode ? `, ${stableCode}` : ''
            }).`
          )
        );
        return;
      }
      if (stderr.trim()) {
        reject(new Error('relayfile lifecycle command produced unexpected stderr on success.'));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as unknown);
      } catch {
        reject(new Error('relayfile lifecycle command returned malformed JSON.'));
      }
    });

    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    if (input.stdin === undefined) child.stdin.end();
    else child.stdin.end(input.stdin);
  });
};

export function createRelayfileSealLifecycle(
  options: {
    binary?: string;
    runner?: RelayfileLifecycleCommandRunner;
  } = {}
): RelayfileSealLifecycle {
  const binary = options.binary ?? 'relayfile';
  const runner = options.runner ?? runRelayfileLifecycleJsonCommand;

  const resume = async (restore: CodexMountRestoreIdentity, signal?: AbortSignal): Promise<void> => {
    const output = await runner({
      binary,
      args: ['mount', 'resume-seal', '--root', restore.localRoot, '--json'],
      stdin: `${JSON.stringify({ resumeId: restore.resumeId ?? restore.lifecycleId })}\n`,
      signal,
    });
    validateResumeOutput(output, restore);
  };

  return {
    checkpointAndSeal: async (input): Promise<CodexWorkspaceSealHandle> => {
      let sealed: ReturnType<typeof validateCheckpointOutput>;
      try {
        const output = await runner({
          binary,
          args: [
            'mount',
            'checkpoint-seal',
            '--root',
            input.workspaceRoot,
            '--session',
            input.sessionId,
            '--generation',
            String(input.generation),
            '--lifecycle-id',
            input.lifecycleId,
            '--timeout',
            '30s',
            '--ttl',
            '60s',
            '--json',
          ],
          signal: input.signal,
        });
        sealed = validateCheckpointOutput(output, input);
      } catch (error) {
        await resume({ lifecycleId: input.lifecycleId, localRoot: input.workspaceRoot }).catch(
          () => undefined
        );
        throw error;
      }
      return {
        ...sealed,
        resumeLocal: (signal) => resume(sealed.restore, signal),
        close: async () => undefined,
      };
    },
    resumePersistedLocalMount: async (input): Promise<void> => {
      if (input.restore.localRoot !== input.workspaceRoot) {
        throw new Error('Persisted relayfile restore identity does not match the managed workspace root.');
      }
      await resume(input.restore, input.signal);
    },
  };
}
