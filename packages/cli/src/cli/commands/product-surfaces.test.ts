import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import type { RelayCliIo, RelayCliSurface } from '@agent-relay/cli-surface';

import {
  PRODUCT_SURFACES,
  loadProductSurface,
  registerProductSurfaceCommands,
  type ProductSurfaceDefinition,
  type ProductSurfaceDependencies,
} from './product-surfaces.js';

const DEFINITION: ProductSurfaceDefinition = {
  as: 'file',
  description: 'relayfile commands',
  specifier: '@relayfile/sdk/relay-cli',
};

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

function fakeSurface(overrides: Partial<RelayCliSurface> = {}): RelayCliSurface {
  return {
    id: 'relayfile',
    version: '0.10.56',
    contract: 1,
    commands: [{ name: 'ls', description: 'List files' }],
    run: vi.fn(async () => 0),
    ...overrides,
  };
}

function makeDeps(
  importModule: (specifier: string) => Promise<unknown>,
  io: RelayCliIo = makeIo()
): ProductSurfaceDependencies {
  return {
    importModule,
    io,
    exit: ((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never,
  };
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`boom ${code}`), { code });
}

describe('PRODUCT_SURFACES', () => {
  it('mounts the three products on their agreed group names', () => {
    expect(PRODUCT_SURFACES.map((surface) => [surface.as, surface.specifier])).toEqual([
      ['file', '@relayfile/sdk/relay-cli'],
      ['flows', '@relayflows/sdk/relay-cli'],
      ['sessions', 'ai-hist/relay-cli'],
    ]);
  });

  it('gives every group a description for the root help', () => {
    for (const definition of PRODUCT_SURFACES) {
      expect(definition.description.trim()).not.toBe('');
    }
  });
});

describe('loadProductSurface', () => {
  it('returns the surface the product factory builds', async () => {
    const surface = fakeSurface();
    const loaded = await loadProductSurface(
      DEFINITION,
      makeDeps(async () => ({ createRelayCliSurface: () => surface }))
    );
    expect(loaded).toBe(surface);
  });

  it('applies extend so a group can span more than one package', async () => {
    // `sessions` composes local history with its cloud client; the user must
    // see one tree, not our package split.
    const base = fakeSurface();
    const extended = fakeSurface({ id: 'relayhistory' });
    const loaded = await loadProductSurface(
      { ...DEFINITION, extend: () => extended },
      makeDeps(async () => ({ createRelayCliSurface: () => base }))
    );
    expect(loaded).toBe(extended);
  });

  it('names the package to install when it is missing', async () => {
    await expect(
      loadProductSurface(
        DEFINITION,
        makeDeps(async () => {
          throw errorWithCode('ERR_MODULE_NOT_FOUND');
        })
      )
    ).rejects.toThrow(/needs @relayfile\/sdk, which is not installed/);
  });

  it('says to upgrade when the package predates the subpath export', async () => {
    // The raw ERR_PACKAGE_PATH_NOT_EXPORTED text never names the fix.
    await expect(
      loadProductSurface(
        DEFINITION,
        makeDeps(async () => {
          throw errorWithCode('ERR_PACKAGE_PATH_NOT_EXPORTED');
        })
      )
    ).rejects.toThrow(/installed @relayfile\/sdk is too old[\s\S]*Upgrade @relayfile\/sdk/);
  });

  it('derives the package name correctly for an unscoped specifier', async () => {
    await expect(
      loadProductSurface(
        { as: 'sessions', description: 'history', specifier: 'ai-hist/relay-cli' },
        makeDeps(async () => {
          throw errorWithCode('ERR_MODULE_NOT_FOUND');
        })
      )
    ).rejects.toThrow(/needs ai-hist, which is not installed/);
  });

  it('surfaces an unexpected import failure with its message intact', async () => {
    await expect(
      loadProductSurface(
        DEFINITION,
        makeDeps(async () => {
          throw new Error('disk on fire');
        })
      )
    ).rejects.toThrow(/Could not load `agent-relay file`[\s\S]*disk on fire/);
  });

  it('rejects a module that exports no factory', async () => {
    await expect(
      loadProductSurface(
        DEFINITION,
        makeDeps(async () => ({}))
      )
    ).rejects.toThrow(/does not export createRelayCliSurface/);
  });
});

describe('registerProductSurfaceCommands', () => {
  function program(importModule: (specifier: string) => Promise<unknown>, io: RelayCliIo) {
    const root = new Command('agent-relay');
    root.exitOverride();
    root.enablePositionalOptions();
    registerProductSurfaceCommands(root, makeDeps(importModule, io));
    return root;
  }

  it('lists every product group in the root help', () => {
    const help = program(async () => ({}), makeIo()).helpInformation();
    expect(help).toMatch(/^\s+file\b/m);
    expect(help).toMatch(/^\s+flows\b/m);
    expect(help).toMatch(/^\s+sessions\b/m);
  });

  it('imports nothing while only rendering root help', () => {
    // Cold `agent-relay --help` must not load three product SDKs.
    const importModule = vi.fn(async () => ({ createRelayCliSurface: () => fakeSurface() }));
    program(importModule, makeIo()).helpInformation();
    expect(importModule).not.toHaveBeenCalled();
  });

  it('imports only the group that was invoked', async () => {
    const importModule = vi.fn(async () => ({ createRelayCliSurface: () => fakeSurface() }));
    await program(importModule, makeIo()).parseAsync(['file', 'ls'], { from: 'user' });

    expect(importModule).toHaveBeenCalledTimes(1);
    expect(importModule).toHaveBeenCalledWith('@relayfile/sdk/relay-cli');
  });

  it('forwards product argv verbatim through the group', async () => {
    const run = vi.fn(async () => 0);
    const io = makeIo();
    await program(async () => ({ createRelayCliSurface: () => fakeSurface({ run }) }), io).parseAsync(
      ['file', 'ls', '--json', '--depth', '2'],
      { from: 'user' }
    );

    expect(run).toHaveBeenCalledWith(['ls', '--json', '--depth', '2'], io);
  });

  it('reports a load failure through the surface error path rather than crashing', async () => {
    const io = makeIo();
    const root = program(async () => {
      throw errorWithCode('ERR_MODULE_NOT_FOUND');
    }, io);

    await expect(root.parseAsync(['file', 'ls'], { from: 'user' })).rejects.toThrow('exit:1');
    // The actionable text has to reach the user, not just the exit code.
    expect(io.err).toContain('needs @relayfile/sdk, which is not installed');
    expect(io.err).not.toContain('ERR_MODULE_NOT_FOUND');
  });
});
