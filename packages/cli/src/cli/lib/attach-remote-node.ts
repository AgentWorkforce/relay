import { spawn as spawnChildProcess, type ChildProcess, type SpawnOptions } from 'node:child_process';

import type { NativeAttachOptions } from './attach-native.js';

export type RemoteAttachMode = 'drive' | 'view' | 'passthrough';

export type RemoteNodeAttachOptions = Pick<
  NativeAttachOptions,
  'stateDir' | 'json' | 'reasoning' | 'diagnostics'
>;

export interface RemoteNodeAttachDependencies {
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  error(message: string): void;
}

function defaultDependencies(): RemoteNodeAttachDependencies {
  return {
    spawn: (command, args, options) => spawnChildProcess(command, [...args], options),
    error: (message) => console.error(message),
  };
}

/** Quote one argument for the target host's POSIX login shell. */
export function quoteRemoteArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validateSshNode(node: string): string | null {
  const trimmed = node.trim();
  if (!trimmed || trimmed.startsWith('-') || !/^[A-Za-z0-9_.@-]+$/.test(trimmed)) return null;
  return trimmed;
}

function defaultRemoteStateDir(node: string): string {
  const host = node.slice(node.lastIndexOf('@') + 1);
  return `"$HOME"/.agentworkforce/relay/${quoteRemoteArg(`${host}-node`)}/state`;
}

function explicitRemoteStateDir(override: string): string {
  const trimmed = override.trim();
  if (trimmed === '~') return '"$HOME"';
  if (trimmed.startsWith('~/')) return `"$HOME"/${quoteRemoteArg(trimmed.slice(2))}`;
  return quoteRemoteArg(trimmed);
}

function remoteStateSelection(
  node: string,
  override: string | undefined
): { setup: string[]; argument: string } {
  const trimmed = override?.trim();
  if (trimmed) return { setup: [], argument: explicitRemoteStateDir(trimmed) };

  const expected = defaultRemoteStateDir(node);
  const discoveryError = quoteRemoteArg(
    'Error: could not uniquely find the fleet broker state directory; pass --state-dir.'
  );
  return {
    setup: [
      `relay_state=${expected}`,
      'if [ ! -f "$relay_state/connection.json" ]; then ' +
        'set -- "$HOME"/.agentworkforce/relay/*-node/state/connection.json; ' +
        'if [ "$#" -eq 1 ] && [ -f "$1" ]; then ' +
        'relay_state=${1%/connection.json}; ' +
        `else printf '%s\\n' ${discoveryError} >&2; exit 78; fi; fi`,
    ],
    argument: '"$relay_state"',
  };
}

export function buildRemoteNodeAttachCommand(
  agentName: string,
  mode: RemoteAttachMode,
  node: string,
  options: RemoteNodeAttachOptions
): { host: string; command: string } | null {
  const host = validateSshNode(node);
  if (!host) return null;
  const state = remoteStateSelection(host, options.stateDir);

  const args = [
    'agent-relay',
    'node',
    'agent',
    'attach',
    quoteRemoteArg(agentName),
    '--mode',
    quoteRemoteArg(mode),
    '--state-dir',
    state.argument,
  ];
  if (options.json) args.push('--json');
  if (options.reasoning) args.push('--reasoning');
  if (options.diagnostics) args.push('--diagnostics');
  return { host, command: [...state.setup, `exec ${args.join(' ')}`].join('; ') };
}

/**
 * Attach through an SSH-reachable physical fleet node without exporting the
 * broker listener or copying its API key off the host. The existing remote
 * attach command owns the terminal protocol and mode semantics.
 */
export async function attachRemoteNode(
  agentName: string,
  mode: RemoteAttachMode,
  node: string,
  options: RemoteNodeAttachOptions,
  overrides: Partial<RemoteNodeAttachDependencies> = {}
): Promise<number> {
  const deps = { ...defaultDependencies(), ...overrides };
  const target = buildRemoteNodeAttachCommand(agentName, mode, node, options);
  if (!target) {
    deps.error(`Error: invalid SSH fleet node ${JSON.stringify(node)}.`);
    return 1;
  }

  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    // JSON mode is a machine-readable stream: no remote PTY, login banner, or
    // stderr/stdout merging. Interactive modes require a forced TTY even when
    // this local CLI's stdin is itself attached indirectly.
    const ttyFlag = options.json ? '-T' : '-tt';
    const child = deps.spawn('ssh', [ttyFlag, target.host, target.command], { stdio: 'inherit' });
    child.once('error', (error) => {
      deps.error(`Error: could not start SSH attach to node '${target.host}': ${error.message}`);
      finish(1);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        deps.error(`Error: SSH attach to node '${target.host}' ended by signal ${signal}.`);
        finish(1);
        return;
      }
      if (code === 255) {
        deps.error(`Error: node '${target.host}' is not reachable over SSH.`);
      }
      finish(code ?? 1);
    });
  });
}
