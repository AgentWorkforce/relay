import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';
import YAML from 'yaml';

import {
  type CodexHookMap,
  runCodexWebsocketConnect,
} from '../lib/connect/codex-websocket.js';
import { runHostedSdkConnect } from '../lib/connect/hosted-sdk.js';
import {
  type ConnectProvider,
  runSdkConnect,
} from '../lib/connect/sdk.js';

export type ConnectPath = 'sdk' | 'websocket';

interface ConnectOptions {
  path?: string;
  endpoint?: string;
  model?: string;
  cwd?: string;
  task?: string;
  timeout?: string;
  spawnAppServer?: boolean;
  hooksFile?: string;
  hook?: string[] | string;
  hosted?: boolean;
  apiKey?: string;
  baseUrl?: string;
  agentName?: string;
  channel?: string;
  allowCli?: string[] | string;
}

export interface ConnectDependencies {
  cwd: () => string;
  readFileSync: (filePath: string, encoding: BufferEncoding) => string;
  env: () => NodeJS.ProcessEnv;
  runSdkConnect: typeof runSdkConnect;
  runCodexWebsocketConnect: typeof runCodexWebsocketConnect;
  runHostedSdkConnect: typeof runHostedSdkConnect;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never;
}

const DEFAULT_ENDPOINT = 'ws://127.0.0.1:4500';
const DEFAULT_MODEL = 'gpt-5.1-codex';

const PATH_VALUES = new Set<ConnectPath>(['sdk', 'websocket']);
const PROVIDER_VALUES = new Set<ConnectProvider>(['codex', 'claude']);

function withDefaults(overrides: Partial<ConnectDependencies> = {}): ConnectDependencies {
  return {
    cwd: () => process.cwd(),
    readFileSync: (filePath: string, encoding: BufferEncoding) => fs.readFileSync(filePath, encoding),
    env: () => process.env,
    runSdkConnect,
    runCodexWebsocketConnect,
    runHostedSdkConnect,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: (code: number) => process.exit(code),
    ...overrides,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeHookCommands(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (typeof entry === 'string') {
          return [entry];
        }
        if (entry && typeof entry === 'object' && typeof (entry as { command?: unknown }).command === 'string') {
          return [(entry as { command: string }).command];
        }
        return [];
      })
      .filter((entry) => entry.trim().length > 0);
  }

  if (value && typeof value === 'object' && typeof (value as { command?: unknown }).command === 'string') {
    return [(value as { command: string }).command];
  }

  return [];
}

function normalizeHookMap(value: unknown): CodexHookMap {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: CodexHookMap = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const commands = normalizeHookCommands(rawValue);
    if (commands.length > 0) {
      result[key] = commands;
    }
  }

  return result;
}

function parseHooksFile(filePath: string, deps: ConnectDependencies): CodexHookMap {
  const file = deps.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  const parsed = ext === '.json' ? JSON.parse(file) : YAML.parse(file);
  const codexHooks = (parsed as { hooks?: { codex?: unknown } })?.hooks?.codex;
  const source = codexHooks ?? parsed;
  return normalizeHookMap(source);
}

function parseInlineHooks(hooks: string[] | string): CodexHookMap {
  const values = Array.isArray(hooks) ? hooks : [hooks];
  const result: CodexHookMap = {};
  for (const value of values) {
    const [left, ...rest] = value.split('=');
    const key = left.trim().toLowerCase();
    const command = rest.join('=').trim();
    if (!key || !command) {
      continue;
    }
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(command);
  }
  return result;
}

function mergeHooks(base: CodexHookMap, extra: CodexHookMap): CodexHookMap {
  const merged: CodexHookMap = {};
  for (const [key, commands] of Object.entries(base)) {
    merged[key] = [...commands];
  }
  for (const [key, commands] of Object.entries(extra)) {
    if (!merged[key]) {
      merged[key] = [];
    }
    merged[key].push(...commands);
  }
  return merged;
}

function parseTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '30000', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout value: ${raw}`);
  }
  return parsed;
}

function collectHookArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectAllowCliArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerConnectCommands(program: Command, overrides: Partial<ConnectDependencies> = {}): void {
  const deps = withDefaults(overrides);

  program
    .command('connect')
    .description('Connect with isolated transports (SDK, hosted SDK, or Codex WebSocket)')
    .argument('[provider]', 'Provider (codex|claude)', 'codex')
    .option('--path <path>', 'Connection path (sdk|websocket)', 'sdk')
    .option('--endpoint <url>', 'Codex app-server endpoint for websocket path', DEFAULT_ENDPOINT)
    .option('--spawn-app-server', 'Auto-start `codex app-server` for websocket path')
    .option('--model <model>', 'Model for thread/start or SDK spawn', DEFAULT_MODEL)
    .option('--cwd <dir>', 'Working directory for agent runtime')
    .option('--task <text>', 'Initial task/prompt to run')
    .option('--timeout <ms>', 'Timeout in milliseconds', '30000')
    .option('--hooks-file <path>', 'YAML/JSON hooks file for Codex websocket events')
    .option('--hook <event=command>', 'Inline hook command (repeatable)', collectHookArg, [])
    .option('--hosted', 'Run hosted SDK connect loop (Relaycast control channel)')
    .option('--api-key <key>', 'Relaycast workspace API key (defaults to RELAY_API_KEY)')
    .option('--base-url <url>', 'Relaycast base URL (defaults to RELAYCAST_BASE_URL or https://api.relaycast.dev)')
    .option('--agent-name <name>', 'Connector agent identity for hosted mode', 'relay-connect')
    .option('--channel <name>', 'Control channel for hosted mode', 'general')
    .option(
      '--allow-cli <name>',
      'Allowed CLI for hosted spawn commands (repeatable)',
      collectAllowCliArg,
      []
    )
    .action(async (providerInput: string, options: ConnectOptions) => {
      if (options.hosted) {
        const env = deps.env();
        const apiKey = (options.apiKey ?? env.RELAY_API_KEY ?? '').trim();
        if (!apiKey) {
          deps.error('hosted mode requires --api-key or RELAY_API_KEY');
          deps.exit(1);
        }

        try {
          const timeoutMs = parseTimeoutMs(options.timeout);
          const cwd = options.cwd ? path.resolve(options.cwd) : deps.cwd();
          const allowCliValues = Array.isArray(options.allowCli)
            ? options.allowCli
            : typeof options.allowCli === 'string'
              ? [options.allowCli]
              : [];
          const allowedClis =
            allowCliValues.length > 0 ? allowCliValues : ['codex', 'claude', 'gemini', 'aider', 'goose'];

          await deps.runHostedSdkConnect({
            apiKey,
            baseUrl: options.baseUrl ?? env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev',
            agentName: options.agentName ?? 'relay-connect',
            channel: options.channel ?? 'general',
            cwd,
            timeoutMs,
            allowedClis,
          });
        } catch (error) {
          deps.error(`[connect] ${toErrorMessage(error)}`);
          deps.exit(1);
        }
        return;
      }

      const provider = providerInput.trim().toLowerCase() as ConnectProvider;
      if (!PROVIDER_VALUES.has(provider)) {
        deps.error(`Unsupported provider "${providerInput}". Expected codex or claude.`);
        deps.exit(1);
      }

      const pathValue = String(options.path ?? 'sdk').trim().toLowerCase() as ConnectPath;
      if (!PATH_VALUES.has(pathValue)) {
        deps.error(`Unsupported path "${options.path}". Expected sdk or websocket.`);
        deps.exit(1);
      }

      let timeoutMs = 30_000;
      try {
        timeoutMs = parseTimeoutMs(options.timeout);
      } catch (error) {
        deps.error(toErrorMessage(error));
        deps.exit(1);
      }

      const cwd = options.cwd ? path.resolve(options.cwd) : deps.cwd();

      try {
        if (pathValue === 'sdk') {
          await deps.runSdkConnect({
            provider,
            cwd,
            timeoutMs,
            model: options.model,
            task: options.task,
          });
          return;
        }

        if (provider !== 'codex') {
          deps.error('websocket path currently supports only codex');
          deps.exit(1);
        }

        const hooksFromFile = options.hooksFile ? parseHooksFile(path.resolve(options.hooksFile), deps) : {};
        const hooksFromFlags = parseInlineHooks(options.hook ?? []);
        const hooks = mergeHooks(hooksFromFile, hooksFromFlags);

        await deps.runCodexWebsocketConnect({
          endpoint: options.endpoint ?? DEFAULT_ENDPOINT,
          cwd,
          model: options.model ?? DEFAULT_MODEL,
          timeoutMs,
          task: options.task,
          spawnAppServer: options.spawnAppServer,
          hooks,
        });
      } catch (error) {
        deps.error(`[connect] ${toErrorMessage(error)}`);
        deps.exit(1);
      }
    });
}
