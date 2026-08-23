import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

import { CloudLiveTeleportClient, ensureCloudSession } from '@agent-relay/cloud';
import { Command } from 'commander';

import {
  probeCodexEnvironmentCapability,
  StdioCodexAppServerSession,
  type CodexNotification,
} from '../lib/codex-app-server.js';
import {
  CodexLiveController,
  CodexTurnRecoveredError,
  FileCodexControllerStateStore,
  type CodexControllerState,
  type CodexPersistedMountResumeProvider,
  type CodexWorkspaceSealProvider,
  type PublicCodexControllerStatus,
} from '../lib/codex-live-controller.js';
import { createRelayfileSealLifecycle } from '../lib/codex-relayfile-seal.js';

export type CodexControllerPaths = {
  directory: string;
  statePath: string;
  socketPath: string;
};

type ControlRequest =
  | { operation: 'status' }
  | { operation: 'teleport'; requestId: string; expectedGeneration: number }
  | { operation: 'rollback' };

type ControlResponse = { ok: true; status: PublicCodexControllerStatus } | { ok: false; error: string };

export interface CodexCommandDependencies {
  runManaged(options: { cwd: string; model?: string; prompt?: string; json?: boolean }): Promise<void>;
  checkpointAndSeal: CodexWorkspaceSealProvider;
  resumePersistedLocalMount: CodexPersistedMountResumeProvider;
  readState(): CodexControllerState | null;
  sendControl(request: ControlRequest): Promise<ControlResponse>;
  requestId(): string;
  cwd(): string;
  log(message: string): void;
}

export function codexControllerPaths(env: NodeJS.ProcessEnv = process.env): CodexControllerPaths {
  const root = env.AGENT_RELAY_STATE_DIR?.trim() || path.join(os.homedir(), '.agent-relay');
  const directory = path.join(root, 'codex-live');
  return {
    directory,
    statePath: path.join(directory, 'active.json'),
    socketPath: path.join(directory, 'controller.sock'),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentMessageDelta(notification: CodexNotification): string | undefined {
  if (!/agentMessage.*delta/i.test(notification.method)) return undefined;
  const params = notification.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const delta = (params as Record<string, unknown>).delta;
  return typeof delta === 'string' ? delta : undefined;
}

export async function runManagedCodexTurn(
  controller: Pick<CodexLiveController, 'runTurn' | 'status'>,
  text: string,
  options: { json: boolean; writeError: (message: string) => void }
): Promise<void> {
  try {
    await controller.runTurn(text);
  } catch (error) {
    const status = controller.status();
    if (error instanceof CodexTurnRecoveredError && status.phase === 'local') {
      options.writeError(
        options.json
          ? `${JSON.stringify({
              method: 'relay/codexTurnRecovered',
              params: {
                code: 'TURN_FAILED_RECOVERED_LOCALLY',
                threadId: status.threadId,
                generation: status.generation,
              },
            })}\n`
          : 'Cloud turn failed; Cloud was fenced and the same Codex thread recovered locally. Retry the turn.\n'
      );
      return;
    }
    throw new Error(
      'Relay-managed Codex cannot continue because execution fencing or local recovery is unconfirmed.',
      { cause: error }
    );
  }
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function createControlServer(controller: CodexLiveController): net.Server {
  let serialized = Promise.resolve();
  return net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      socket.pause();
      serialized = serialized.then(async () => {
        let response: ControlResponse;
        try {
          const request = JSON.parse(line) as ControlRequest;
          if (request.operation === 'status') {
            response = { ok: true, status: controller.status() };
          } else if (request.operation === 'teleport') {
            response = {
              ok: true,
              status: controller.requestTeleport({
                requestId: request.requestId,
                expectedGeneration: request.expectedGeneration,
              }),
            };
          } else if (request.operation === 'rollback') {
            response = { ok: true, status: await controller.rollback() };
          } else {
            throw new Error('Unsupported Codex controller operation.');
          }
        } catch (error) {
          response = { ok: false, error: describeError(error) };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
  });
}

async function sendSocketControl(socketPath: string, request: ControlRequest): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.setTimeout(5_000);
    let buffer = '';
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as ControlResponse);
      } catch (error) {
        reject(new Error('Codex controller returned an invalid response.', { cause: error }));
      }
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Timed out contacting the active Codex controller.'));
    });
    socket.once('error', (error) =>
      reject(new Error('No active Relay-managed Codex session.', { cause: error }))
    );
  });
}

function withDefaults(overrides: Partial<CodexCommandDependencies> = {}): CodexCommandDependencies {
  const paths = codexControllerPaths();
  const relayfileLifecycle = createRelayfileSealLifecycle();
  const checkpointAndSeal = overrides.checkpointAndSeal ?? relayfileLifecycle.checkpointAndSeal;
  const resumePersistedLocalMount =
    overrides.resumePersistedLocalMount ?? relayfileLifecycle.resumePersistedLocalMount;
  return {
    runManaged:
      overrides.runManaged ??
      (async (options) => {
        const workspaceRoot = fs.realpathSync(path.resolve(options.cwd));
        await probeCodexEnvironmentCapability('codex');
        fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
        const store = new FileCodexControllerStateStore(paths.statePath);
        const prior = store.read();
        if (prior && fs.existsSync(paths.socketPath) && processIsAlive(prior.controllerPid)) {
          throw new Error(
            `Relay-managed Codex thread ${prior.threadId} is already controlled by process ${prior.controllerPid}.`
          );
        }
        const session = await ensureCloudSession({ interactive: true });
        const cloud = new CloudLiveTeleportClient(
          (requestPath, init) => session.client.fetch(requestPath, init),
          session.client.snapshot().apiUrl
        );

        const controller = new CodexLiveController(
          {
            workspaceRoot,
            socketPath: paths.socketPath,
            ...(options.model ? { model: options.model } : {}),
          },
          {
            cloud,
            store,
            createAppServer: async () =>
              StdioCodexAppServerSession.spawn({
                cwd: workspaceRoot,
                onNotification: (notification) => {
                  if (options.json) process.stdout.write(`${JSON.stringify(notification)}\n`);
                  else {
                    const delta = agentMessageDelta(notification);
                    if (delta) process.stdout.write(delta);
                  }
                },
              }),
            // Production already probed before interactive Cloud login. Keeping
            // the controller seam injectable lets restart/adversarial tests
            // prove an unsupported local binary still fails closed.
            probeCapability: async () => undefined,
            checkpointAndSeal,
            resumePersistedLocalMount,
            sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
            now: () => new Date(),
            sessionId: randomUUID,
            pid: process.pid,
          }
        );

        try {
          fs.unlinkSync(paths.socketPath);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        const server = createControlServer(controller);
        try {
          const status = await controller.initialize();
          await listen(server, paths.socketPath);
          process.stderr.write(
            `Relay-managed Codex ${status.threadId} is ready locally (generation ${status.generation}).\n`
          );

          if (options.prompt) {
            await runManagedCodexTurn(controller, options.prompt, {
              json: Boolean(options.json),
              writeError: (message) => process.stderr.write(message),
            });
          }
          const input = readline.createInterface({
            input: process.stdin,
            terminal: Boolean(process.stdin.isTTY),
          });
          for await (const line of input) {
            if (!line.trim()) continue;
            await runManagedCodexTurn(controller, line, {
              json: Boolean(options.json),
              writeError: (message) => process.stderr.write(message),
            });
            if (!options.json) process.stdout.write('\n');
          }
        } finally {
          await closeServer(server);
          await controller.close();
          try {
            fs.unlinkSync(paths.socketPath);
          } catch {
            // Already gone.
          }
        }
      }),
    checkpointAndSeal,
    resumePersistedLocalMount,
    readState:
      overrides.readState ??
      (() => {
        try {
          return new FileCodexControllerStateStore(paths.statePath).read();
        } catch {
          return null;
        }
      }),
    sendControl: overrides.sendControl ?? ((request) => sendSocketControl(paths.socketPath, request)),
    requestId: overrides.requestId ?? randomUUID,
    cwd: overrides.cwd ?? (() => process.cwd()),
    log: overrides.log ?? ((message) => console.log(message)),
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error instanceof Error && 'code' in error && error.code === 'EPERM');
  }
}

function requireActiveState(deps: CodexCommandDependencies): CodexControllerState {
  const state = deps.readState();
  if (!state) throw new Error('No active Relay-managed Codex session. Start one with `relay codex run`.');
  return state;
}

function requireSuccess(response: ControlResponse): PublicCodexControllerStatus {
  if (!response.ok) throw new Error(response.error);
  return response.status;
}

export function registerCodexCommands(
  program: Command,
  overrides: Partial<CodexCommandDependencies> = {}
): void {
  const deps = withDefaults(overrides);
  const group = program
    .command('codex')
    .description('Run and relocate a Relay-managed local Codex app-server session');

  group
    .command('run')
    .description('Run a long-lived local Codex app-server and thread under Relay control')
    .argument('[prompt...]', 'Optional first turn')
    .option('--cwd <path>', 'Managed workspace root')
    .option('--model <model>', 'Codex model')
    .option('--json', 'Write raw app-server notifications as JSON lines')
    .action(async (prompt: string[], options: { cwd?: string; model?: string; json?: boolean }) => {
      await deps.runManaged({
        cwd: options.cwd ?? deps.cwd(),
        ...(options.model ? { model: options.model } : {}),
        ...(prompt.length ? { prompt: prompt.join(' ') } : {}),
        ...(options.json ? { json: true } : {}),
      });
    });

  group
    .command('teleport')
    .description('Move execution for the active managed Codex session to Cloud at the next turn boundary')
    .action(async () => {
      const state = requireActiveState(deps);
      const status = requireSuccess(
        await deps.sendControl({
          operation: 'teleport',
          requestId: deps.requestId(),
          expectedGeneration: state.generation,
        })
      );
      deps.log(
        `Codex execution teleport queued for generation ${status.generation}; the local controller remains authoritative.`
      );
    });

  group
    .command('rollback')
    .description('Revoke Cloud execution and resume the same thread through a fresh local controller')
    .action(async () => {
      requireActiveState(deps);
      const status = requireSuccess(await deps.sendControl({ operation: 'rollback' }));
      deps.log(`Codex thread ${status.threadId} resumed locally at generation ${status.generation}.`);
    });

  group
    .command('status')
    .description('Show where execution runs and where the conversation controller lives')
    .option('--json', 'Write machine-readable JSON')
    .action(async (options: { json?: boolean }) => {
      requireActiveState(deps);
      const status = requireSuccess(await deps.sendControl({ operation: 'status' }));
      if (options.json) deps.log(JSON.stringify(status));
      else {
        deps.log(`Execution: ${status.execution}`);
        deps.log('Controller: local (keep this process and laptop running)');
        deps.log(`Thread: ${status.threadId}`);
        deps.log(`Generation: ${status.generation}`);
      }
    });
}
