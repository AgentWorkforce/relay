/**
 * End-to-end mount test against the real product SDKs.
 *
 * Everything else in this repo tests the mount with a fake surface. This drives
 * the actual `@relayfile/sdk`, `@relayflows/sdk`, and `ai-hist` builds through
 * the real commander program, so a contract violation in a product — a
 * malformed spec, a `process.exit`, a tree that disagrees with its dispatcher —
 * fails here rather than in a user's terminal.
 *
 * The product repos are siblings of this one and are not installed in CI, so
 * each case skips when its build is absent. `RELAY_PRODUCT_SURFACES_ROOT`
 * overrides where to look.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { assertSurfaceConforms, walkCommands } from '@agent-relay/cli-surface';
import type { RelayCliIo, RelayCliSurface } from '@agent-relay/cli-surface';

import { registerProductSurfaceCommands, type ProductSurfaceDefinition } from './product-surfaces.js';

// Loading three real product SDKs — one of which resolves a Go binary — costs
// far more than a unit test, and more again when the full suite runs them in
// parallel. The default 5s timeout fails these for being slow, not wrong.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACES_ROOT = process.env['RELAY_PRODUCT_SURFACES_ROOT'] ?? path.resolve(HERE, '../../../../../..');

/** Where each mounted group's built surface lives in its sibling repo. */
const BUILT_SURFACES: Record<string, string> = {
  file: 'relayfile/packages/sdk/typescript/dist/relay-cli/index.js',
  flows: 'flows/packages/sdk/dist/relay-cli.js',
  sessions: 'relayhistory/sdk-ts/dist/relay-cli.js',
};

function builtSurfacePath(group: string): string | undefined {
  const candidate = path.join(WORKSPACES_ROOT, BUILT_SURFACES[group]!);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function makeIo(): RelayCliIo & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    stdout(chunk: string) {
      sink.out += chunk;
    },
    stderr(chunk: string) {
      sink.err += chunk;
    },
  };
  return sink;
}

/** Mount one real product surface on a program, by absolute built path. */
function programFor(group: string, description: string, io: RelayCliIo): Command {
  const program = new Command('agent-relay');
  program.exitOverride();
  program.enablePositionalOptions();
  const definition: ProductSurfaceDefinition = {
    as: group,
    description,
    specifier: builtSurfacePath(group)!,
  };
  registerProductSurfaceCommands(
    program,
    {
      importModule: (specifier) => import(specifier),
      io,
      exit: ((code: number) => {
        throw new Error(`exit:${code}`);
      }) as (code: number) => never,
    },
    [definition]
  );
  return program;
}

async function loadSurface(group: string): Promise<RelayCliSurface> {
  const module = (await import(builtSurfacePath(group)!)) as {
    createRelayCliSurface: () => RelayCliSurface;
  };
  return module.createRelayCliSurface();
}

const GROUPS = [
  { group: 'file', id: 'relayfile', description: 'relayfile commands' },
  { group: 'flows', id: 'relayflows', description: 'relayflows commands' },
  { group: 'sessions', id: 'relayhistory', description: 'session history commands' },
] as const;

describe.each(GROUPS)('mounted product surface: $group', ({ group, id, description }) => {
  const available = builtSurfacePath(group) !== undefined;
  const test = available ? it : it.skip;

  test('conforms to the contract this CLI enforces', async () => {
    const surface = await loadSurface(group);
    expect(surface.id).toBe(id);
    expect(surface.contract).toBe(1);
    // Throws listing every violation, so a product failure names itself.
    expect(() => assertSurfaceConforms(surface)).not.toThrow();
  });

  test('declares a non-trivial command tree with real descriptions', async () => {
    const surface = await loadSurface(group);
    const commands = [...walkCommands(surface.commands)];
    expect(commands.length).toBeGreaterThan(0);
    for (const { path: commandPath, command } of commands) {
      expect(command.description.trim(), `${commandPath.join(' ')} has no description`).not.toBe('');
    }
  });

  test('renders help through the mount, naming agent-relay rather than the product', async () => {
    // The whole reason help is spec-rendered instead of forwarded: a mounted
    // product must not tell users to run `relayfile ...` or `flows ...`.
    const io = makeIo();
    await programFor(group, description, io).parseAsync([group, '--help'], { from: 'user' });

    expect(io.out).toContain(`Usage: agent-relay ${group}`);
    expect(io.out).toContain('Commands:');
    expect(io.out).not.toMatch(/^Usage: (relayfile|flows|ai-hist)\b/m);
  });

  test('renders help for a real nested command', async () => {
    const surface = await loadSurface(group);
    const nested = [...walkCommands(surface.commands)].find(
      (entry) => entry.path.length > 1 && !entry.command.hidden
    );
    if (!nested) return; // Flat surfaces are legitimate.

    const io = makeIo();
    await programFor(group, description, io).parseAsync([group, ...nested.path, '--help'], {
      from: 'user',
    });

    expect(io.out).toContain(`Usage: agent-relay ${group} ${nested.path.join(' ')}`);
  });

  test('rejects an unknown command with exit 2 and the real command list', async () => {
    const io = makeIo();
    const program = programFor(group, description, io);

    await expect(
      program.parseAsync([group, 'definitely-not-a-real-command'], { from: 'user' })
    ).rejects.toThrow('exit:2');

    expect(io.err).toContain("unknown command 'definitely-not-a-real-command'");
    const surface = await loadSurface(group);
    const firstVisible = surface.commands.find((command) => !command.hidden)!;
    expect(io.err).toContain(firstVisible.name);
  });

  test('routes a real command through to the product dispatcher', async () => {
    // Proves argv reaches the product rather than dying in commander. The
    // command is asked for its own help, which every surface can answer
    // without touching a daemon, a network, or the filesystem.
    const surface = await loadSurface(group);
    const first = surface.commands.find((command) => !command.hidden)!;

    let received: readonly string[] | undefined;
    const instrumented: RelayCliSurface = {
      ...surface,
      run: async (argv, io) => {
        received = argv;
        return surface.run(argv, io);
      },
    };

    const io = makeIo();
    const program = new Command('agent-relay');
    program.exitOverride();
    program.enablePositionalOptions();
    registerProductSurfaceCommands(
      program,
      {
        importModule: async () => ({ createRelayCliSurface: () => instrumented }),
        io,
        exit: (() => {
          throw new Error('exit');
        }) as (code: number) => never,
      },
      [{ as: group, description, specifier: 'ignored' }]
    );

    await program
      .parseAsync([group, first.name, '--a-flag-the-host-never-heard-of'], { from: 'user' })
      .catch(() => {
        // The product may reject the unknown flag; argv delivery is the assertion.
      });

    expect(received).toEqual([first.name, '--a-flag-the-host-never-heard-of']);
  });
});

describe('product surface availability', () => {
  it('reports which sibling builds were exercised', () => {
    const built = Object.keys(BUILT_SURFACES).filter((group) => builtSurfacePath(group));
    // Not an assertion on count: CI has no siblings. This keeps the skip
    // visible in output so a silently-skipping suite is noticed.
    expect(Array.isArray(built)).toBe(true);
    console.log(
      built.length === 0
        ? 'product surfaces: none built; mount E2E skipped'
        : `product surfaces exercised: ${built.join(', ')}`
    );
  });
});
