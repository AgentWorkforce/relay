/**
 * Mount the Relay product CLIs as `agent-relay` command groups.
 *
 * `file` -> relayfile, `flows` -> relayflows, `sessions` -> relayhistory.
 * Each product ships its own {@link RelayCliSurface}; this module only says
 * which package backs which group. Command behaviour lives in the product
 * repos, and `mountRelayCliSurface` does the generic wiring.
 */

import type { Command } from 'commander';

import { composeSurfaces, type RelayCliSurface } from '@agent-relay/cli-surface';

import { describeError } from '../lib/describe-error.js';
import { defaultExit } from '../lib/exit.js';
import { mountRelayCliSurface, type RelayCliSurfaceDependencies } from '../lib/relay-cli-surface.js';

/** How one product group is mounted. */
export interface ProductSurfaceDefinition {
  /** Group name under `agent-relay`. */
  as: string;
  /** One-line description for `agent-relay --help`. */
  description: string;
  /**
   * Package subpath exporting `createRelayCliSurface`.
   *
   * Imported lazily, so an `agent-relay` invocation that never touches this
   * group never pays to load the product SDK.
   */
  specifier: string;
  /** Additional group names reaching the same surface, hidden from help. */
  hiddenAliases?: readonly string[];
  /**
   * Options handed to the product's `createRelayCliSurface`.
   *
   * `sessions` uses this to pass a Relayhistory cloud client, which makes the
   * product's `cloud …` commands appear. Resolved lazily alongside the import,
   * so building a client costs nothing until the group is used.
   */
  createOptions?: () => unknown | Promise<unknown>;
  /**
   * Optionally widen the product surface before mounting.
   *
   * `sessions` uses this to compose relayhistory's local commands with its
   * cloud client, so the user sees one tree rather than our package split.
   */
  extend?: (base: RelayCliSurface) => Promise<RelayCliSurface> | RelayCliSurface;
}

/** Shape a product's `relay-cli` entry point must export. */
interface SurfaceModule {
  createRelayCliSurface?: (options?: unknown) => RelayCliSurface;
}

/** Injectable import hook, so tests can mount fakes without publishing packages. */
export interface ProductSurfaceDependencies extends RelayCliSurfaceDependencies {
  importModule: (specifier: string) => Promise<unknown>;
}

/** The product groups `agent-relay` mounts. */
export const PRODUCT_SURFACES: readonly ProductSurfaceDefinition[] = [
  {
    as: 'file',
    description: 'relayfile — read and write provider files through a local mount',
    specifier: '@relayfile/sdk/relay-cli',
  },
  {
    as: 'flows',
    description: 'relayflows — author, check, run, and deploy agent workflows',
    specifier: '@relayflows/sdk/relay-cli',
  },
  {
    as: 'sessions',
    description: 'Relay session history — search, replay, and export past sessions',
    specifier: 'ai-hist/relay-cli',
    // `agent-relay session replay` predates this group and still works; it is
    // hidden so help shows one name for one thing.
    hiddenAliases: ['session'],
    createOptions: createSessionsSurfaceOptions,
    extend: composeSessionReplay,
  },
];

/**
 * Build the Relayhistory cloud client that unlocks `sessions cloud …`.
 *
 * Returns no client when Relayhistory is not configured: ai-hist then drops
 * those commands from its declared tree, so help never advertises something
 * that cannot run.
 */
async function createSessionsSurfaceOptions(): Promise<{ cloud?: unknown }> {
  const { readStoredRelayhistoryAuth, resolveRelayhistoryConfig } = await import('./session.js');
  const { baseUrl, token } = resolveRelayhistoryConfig(readStoredRelayhistoryAuth());
  if (!baseUrl || !token) return {};

  try {
    const { createRelayhistoryCloudClient } = await import('@relayhistory/cloud-client');
    return { cloud: createRelayhistoryCloudClient({ baseUrl, token }) };
  } catch {
    // The cloud client is optional: without it the local half still mounts,
    // which is strictly better than failing the whole group.
    return {};
  }
}

/** Compose Relay's own `replay` into the session history tree. */
async function composeSessionReplay(base: RelayCliSurface): Promise<RelayCliSurface> {
  const { createSessionReplaySurface } = await import('./session.js');
  return composeSurfaces({
    id: base.id,
    version: base.version,
    parts: [base, createSessionReplaySurface(base.version)],
  });
}

/**
 * Explain an import failure in terms the operator can act on.
 *
 * A missing subpath export is the common case while a product is mid-upgrade,
 * and the raw `ERR_PACKAGE_PATH_NOT_EXPORTED` text does not say which package
 * to update.
 */
function describeLoadFailure(definition: ProductSurfaceDefinition, error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  const packageName = definition.specifier
    .split('/')
    .slice(0, definition.specifier.startsWith('@') ? 2 : 1)
    .join('/');

  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return (
      `\`agent-relay ${definition.as}\` needs ${packageName}, which is not installed.\n` +
      `Reinstall agent-relay, or install ${packageName} alongside it.`
    );
  }
  if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return (
      `The installed ${packageName} is too old for \`agent-relay ${definition.as}\`: ` +
      `it does not export ${definition.specifier}.\nUpgrade ${packageName} and retry.`
    );
  }
  return `Could not load \`agent-relay ${definition.as}\` from ${definition.specifier}: ${describeError(error)}`;
}

/**
 * Import a product's surface and prepare it for mounting.
 *
 * @param definition - The group being loaded.
 * @param deps - Import hook and output sink.
 * @returns The surface, extended when the definition asks for it.
 * @throws With an actionable message when the package is missing, too old, or
 *   does not export the expected factory.
 */
export async function loadProductSurface(
  definition: ProductSurfaceDefinition,
  deps: ProductSurfaceDependencies
): Promise<RelayCliSurface> {
  let module: SurfaceModule;
  try {
    module = (await deps.importModule(definition.specifier)) as SurfaceModule;
  } catch (error) {
    throw new Error(describeLoadFailure(definition, error));
  }

  if (typeof module.createRelayCliSurface !== 'function') {
    throw new Error(
      `${definition.specifier} does not export createRelayCliSurface(). ` +
        `\`agent-relay ${definition.as}\` cannot be mounted.`
    );
  }

  const options = definition.createOptions ? await definition.createOptions() : undefined;
  const base = module.createRelayCliSurface(options);
  return definition.extend ? await definition.extend(base) : base;
}

/**
 * Register every product group on the root program.
 *
 * @param program - The root commander program.
 * @param overrides - Test seams for import, io, and exit.
 * @param definitions - Groups to mount; defaults to {@link PRODUCT_SURFACES}.
 */
export function registerProductSurfaceCommands(
  program: Command,
  overrides: Partial<ProductSurfaceDependencies> = {},
  definitions: readonly ProductSurfaceDefinition[] = PRODUCT_SURFACES
): void {
  const deps: ProductSurfaceDependencies = {
    importModule: overrides.importModule ?? ((specifier: string) => import(specifier)),
    io: overrides.io ?? {
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
    },
    exit: overrides.exit ?? defaultExit,
  };

  for (const definition of definitions) {
    mountRelayCliSurface(
      program,
      {
        as: definition.as,
        description: definition.description,
        ...(definition.hiddenAliases ? { hiddenAliases: definition.hiddenAliases } : {}),
        load: () => loadProductSurface(definition, deps),
      },
      deps
    );
  }
}
