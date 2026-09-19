import { readFileSync } from 'node:fs';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import type { RelayCliIo, RelayCliSurface } from '@agent-relay/cli-surface';

import {
  PRODUCT_SURFACES,
  importProductSurface,
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

  it('separates an incomplete install from a missing package', async () => {
    // ERR_MODULE_NOT_FOUND covers both, and reporting the second as "not
    // installed" sends the operator to reinstall a package already on disk.
    // Reported against a global install mid-upgrade to 12.2.5.
    const partial = Object.assign(
      new Error(
        "Cannot find module '/usr/lib/node_modules/agent-relay/node_modules/@relayfile/sdk/dist/relay-cli/index.js'"
      ),
      { code: 'ERR_MODULE_NOT_FOUND' }
    );
    await expect(
      loadProductSurface(
        DEFINITION,
        makeDeps(async () => {
          throw partial;
        })
      )
    ).rejects.toThrow(/installed but incomplete/);
  });

  it('names the dependency when the product itself is present', async () => {
    // Reinstalling @relayfile/sdk would not fix a missing transitive dep, so
    // the message must not name @relayfile/sdk as the thing to install.
    const transitive = Object.assign(
      new Error("Cannot find package 'some-transitive-dep' imported from /x/y.js"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    );
    await expect(
      loadProductSurface(
        DEFINITION,
        makeDeps(async () => {
          throw transitive;
        })
      )
    ).rejects.toThrow(/depends on some-transitive-dep, which is not installed/);
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

describe('importProductSurface', () => {
  it('has a bundler-visible literal for every mounted surface', () => {
    // The standalone build bundles with esbuild, which cannot see through
    // `import(someVariable)`. A group whose specifier is missing here compiles
    // and passes every other test, then fails at runtime in the compiled
    // binary with MODULE_NOT_FOUND — reported as "not installed", in a
    // distribution where installing cannot help (#1795).
    const source = readFileSync(
      new URL('./product-surfaces.ts', import.meta.url),
      'utf8'
    );
    for (const definition of PRODUCT_SURFACES) {
      expect(
        source.includes(`import('${definition.specifier}')`),
        `${definition.as} has no literal import('${definition.specifier}'); ` +
          'the standalone binary will not bundle it'
      ).toBe(true);
    }
  });

  it('still resolves a specifier outside the table', async () => {
    // The end-to-end test mounts product builds by absolute path, so the
    // dynamic fallback has to stay.
    await expect(importProductSurface('node:path')).resolves.toHaveProperty('join');
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

describe('process stderr redaction', () => {
  /** Drive a mounted surface with the real default io (no overrides). */
  async function runWithRealIo(emit: (io: RelayCliIo) => void): Promise<string> {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      written.push(typeof chunk === 'string' ? chunk : `<bytes:${(chunk as Uint8Array).length}>`);
      return true;
    }) as never);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
    const program = new Command('agent-relay');
    program.exitOverride();
    program.enablePositionalOptions();
    registerProductSurfaceCommands(
      program,
      {
        importModule: async () => ({
          createRelayCliSurface: () =>
            fakeSurface({
              run: async (_argv, io) => {
                emit(io);
                return 0;
              },
            }),
        }),
        // io intentionally NOT overridden: this exercises the real sink.
        exit: ((code: number) => {
          throw new Error(`exit:${code}`);
        }) as (code: number) => never,
      },
      [DEFINITION]
    );
    try {
      await program.parseAsync(['file', 'ls'], { from: 'user' });
    } finally {
      spy.mockRestore();
      stdout.mockRestore();
    }
    return written.join('');
  }

  it('masks a credential a mounted product echoes to stderr', async () => {
    // A product that echoes argv back — "unknown flag --api-key=rk_live_…" —
    // would otherwise leak the secret, because it writes through the injected
    // sink and so bypasses commander's own redaction.
    const output = await runWithRealIo((io) => {
      io.stderr('error: unknown option --api-key=rk_live_0123456789abcdef\n');
    });

    expect(output).not.toContain('rk_live_0123456789abcdef');
    expect(output).toContain('rk_live_…cdef');
  });

  it('passes binary stderr chunks through without attempting to mask them', async () => {
    const output = await runWithRealIo((io) => {
      io.stderr(new Uint8Array([0xff, 0xfe, 0x00]));
    });

    expect(output).toBe('<bytes:3>');
  });
});
