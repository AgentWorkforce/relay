import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn as spawnProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface AuthSshRuntime {
  fetch: typeof fetch;
  loadSSH2: () => Promise<typeof import('ssh2') | null>;
  createAskpassScript: (password: string) => string;
  buildSystemSshArgs: (options: {
    host: string;
    port: number;
    username: string;
    localPort?: number;
    remotePort?: number;
  }) => string[];
  spawnProcess: typeof spawnProcess;
  createServer: typeof createServer;
  setTimeout: typeof setTimeout;
}

export async function loadSSH2(): Promise<typeof import('ssh2') | null> {
  try {
    return await import('ssh2');
  } catch {
    return null;
  }
}

/**
 * Create a temporary SSH_ASKPASS helper script that echoes the given password.
 * Returns the script path. Caller must clean up.
 */
export function createAskpassScript(password: string): string {
  const askpassPath = path.join(tmpdir(), `ar-askpass-${process.pid}-${Date.now()}`);
  const escaped = password.replace(/'/g, "'\"'\"'");
  fs.writeFileSync(askpassPath, `#!/bin/sh\nprintf '%s\\n' '${escaped}'\n`, { mode: 0o700 });
  return askpassPath;
}

/**
 * Build SSH args common to both auth and connect commands.
 */
export function buildSystemSshArgs(options: {
  host: string;
  port: number;
  username: string;
  localPort?: number;
  remotePort?: number;
}): string[] {
  const args = [
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    '-o',
    'LogLevel=ERROR',
    '-p',
    String(options.port),
  ];
  if (options.localPort && options.remotePort) {
    args.push('-L', `${options.localPort}:localhost:${options.remotePort}`);
  }
  return args;
}

export const DEFAULT_SSH_RUNTIME: AuthSshRuntime = {
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init),
  loadSSH2,
  createAskpassScript,
  buildSystemSshArgs,
  spawnProcess,
  createServer,
  setTimeout,
};
