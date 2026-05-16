import { Command } from 'commander';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { registerConnectCommands } from './connect.js';
import { CliDetectError } from '../lib/detect-cli.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

interface Harness {
  program: Command;
  logs: string[];
  errors: string[];
  exitCode: number | undefined;
  connect: ReturnType<typeof vi.fn>;
}

function createHarness(connectImpl?: (cli: string) => Promise<{ cli: string; version: string; binPath: string; manifestPath: string }>): Harness {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  const exit = (code: number): never => {
    exitCode = code;
    throw new ExitSignal(code);
  };
  const connect = vi.fn(
    connectImpl ??
      (async (cli: string) => ({
        cli,
        version: '1.2.3',
        binPath: `/usr/local/bin/${cli}`,
        manifestPath: '/tmp/agent-relay/connections.json',
      })),
  );

  const program = new Command();
  program.exitOverride();
  registerConnectCommands(program, {
    connect: connect as any,
    log: (msg) => logs.push(msg),
    error: (msg) => errors.push(msg),
    exit,
  });
  return {
    program,
    logs,
    errors,
    get exitCode() {
      return exitCode;
    },
    connect,
  } as Harness;
}

async function run(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    throw err;
  }
}

describe('registerConnectCommands', () => {
  it('runs the happy path for claude', async () => {
    const h = createHarness();
    const code = await run(h.program, ['connect', 'claude']);
    expect(code).toBeUndefined();
    expect(h.connect).toHaveBeenCalledWith('claude', undefined);
    expect(h.logs.join('\n')).toContain('Connected claude 1.2.3');
    expect(h.logs.join('\n')).toContain('Manifest:');
  });

  it('runs the happy path for codex', async () => {
    const h = createHarness();
    await run(h.program, ['connect', 'codex']);
    expect(h.connect).toHaveBeenCalledWith('codex', undefined);
  });

  it('runs the happy path for gemini', async () => {
    const h = createHarness();
    await run(h.program, ['connect', 'gemini']);
    expect(h.connect).toHaveBeenCalledWith('gemini', undefined);
  });

  it('prints the deprecation banner for unknown providers and exits 1', async () => {
    const h = createHarness();
    const code = await run(h.program, ['connect', 'anthropic']);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain('[DEPRECATED]');
    expect(h.errors.join('\n')).toContain('agent-relay cloud connect anthropic');
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('still accepts legacy cloud-connect options before printing the deprecation banner', async () => {
    const h = createHarness();
    const code = await run(h.program, [
      'connect',
      'anthropic',
      '--timeout',
      '300',
      '--language',
      'typescript',
      '--cloud-url',
      'https://cloud.example.test',
    ]);
    expect(code).toBe(1);
    expect(h.errors.join('\n')).toContain('agent-relay cloud connect anthropic');
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('surfaces NEEDS_CLI_INSTALL via stderr and exits 2', async () => {
    const h = createHarness(async () => {
      throw new CliDetectError(
        'NEEDS_CLI_INSTALL',
        2,
        'NEEDS_CLI_INSTALL: claude not found on PATH. Install: https://docs.anthropic.com/claude-code/install',
      );
    });
    const code = await run(h.program, ['connect', 'claude']);
    expect(code).toBe(2);
    expect(h.errors.join('\n')).toContain('NEEDS_CLI_INSTALL');
    expect(h.errors.join('\n')).toContain('claude not found on PATH');
    expect(h.errors.join('\n')).toContain('https://docs.anthropic.com/claude-code/install');
  });

  it('surfaces CLI_VERSION_FAILED via stderr and exits 3', async () => {
    const h = createHarness(async () => {
      throw new CliDetectError('CLI_VERSION_FAILED', 3, 'claude found but --version failed');
    });
    const code = await run(h.program, ['connect', 'claude']);
    expect(code).toBe(3);
    expect(h.errors.join('\n')).toContain('--version failed');
  });

  it('exits 4 for unexpected errors', async () => {
    const h = createHarness(async () => {
      throw new Error('boom');
    });
    const code = await run(h.program, ['connect', 'claude']);
    expect(code).toBe(4);
    expect(h.errors.join('\n')).toContain('boom');
  });

  it('end-to-end writes a manifest entry through the real connections-file helper', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'connect-cmd-'));
    try {
      const { upsertConnectionsManifest } = await import('../lib/connections-file.js');
      const harness = createHarness(async (cli) => {
        const { manifestPath } = await upsertConnectionsManifest(
          {
            cli: cli as 'claude',
            binPath: `/usr/local/bin/${cli}`,
            version: '9.9.9',
            rawVersionOutput: `${cli} 9.9.9`,
            connectedAt: '2026-05-16T00:00:00.000Z',
          },
          { xdgConfigHome: tmp },
        );
        return { cli, version: '9.9.9', binPath: `/usr/local/bin/${cli}`, manifestPath };
      });
      await run(harness.program, ['connect', 'claude']);
      const manifestPath = path.join(tmp, 'agent-relay', 'connections.json');
      const body = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(body.clis.claude.version).toBe('9.9.9');
      if (process.platform !== 'win32') {
        expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
