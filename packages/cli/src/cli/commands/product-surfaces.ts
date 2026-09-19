/**
 * Mount the Relay product CLIs as `agent-relay` command groups.
 *
 * `file` -> relayfile, `flows` -> relayflows, `sessions` -> relayhistory.
 * Each product ships its own {@link RelayCliSurface}; this module only says
 * which package backs which group. Command behaviour lives in the product
 * repos, and `mountRelayCliSurface` does the generic wiring.
 */

import type { Command } from 'commander';

import { composeSurfaces, type RelayCliIo, type RelayCliSurface } from '@agent-relay/cli-surface';

import { describeError } from '../lib/describe-error.js';
import { redactCredentialValues } from '@agent-relay/cloud/redact';

import { defaultExit } from '../lib/exit.js';
import {
  importFromSurfaceStore,
  isCompiledStandalone,
  provisionSurfacePackage,
  PROVISION_ERROR_CODE,
  SurfaceProvisionError,
  type SurfacePackage,
} from '../lib/product-surface-store.js';
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

/**
 * The real process streams, with credentials masked on stderr.
 *
 * Commander's own parse errors are already redacted, but a mounted product
 * writes through the injected sink, so its diagnostics would bypass that and
 * echo a credential a user put in argv. Only stderr is masked: stdout is the
 * data the caller asked for, it can be binary (`file export --format tar
 * --output -`), and rewriting it would corrupt the payload.
 */
function processIo(): RelayCliIo {
  return {
    stdout: (chunk) => process.stdout.write(chunk),
    // Bytes pass through untouched — there is nothing to mask in a binary
    // chunk, and decoding one to scan it would corrupt what gets written.
    stderr: (chunk) =>
      process.stderr.write(typeof chunk === 'string' ? redactCredentialValues(chunk) : chunk),
  };
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
 * The npm spec behind each mounted surface, mirroring `packages/cli/package.json`.
 *
 * Only the compiled standalone binary reads this: it has no `node_modules` and
 * no manifest on disk, so when a specifier does not resolve it installs the
 * package itself, and the version it installs has to be the one the npm
 * distribution would have had. `product-surfaces.test.ts` asserts these ranges
 * still match the manifest, because a pin bumped in one place and not the other
 * is invisible until someone runs the binary.
 */
export const SURFACE_PACKAGES: Readonly<Record<string, SurfacePackage>> = {
  '@relayfile/sdk/relay-cli': { name: '@relayfile/sdk', range: '^0.10.64' },
  '@relayflows/sdk/relay-cli': { name: '@relayflows/sdk', range: '^2.0.19' },
  'ai-hist/relay-cli': { name: 'ai-hist', range: '^0.18.1' },
};

/** Seams for the standalone fallback; the defaults are the real store. */
export interface SurfaceImportDependencies {
  /** Plain `import()`. The only path the npm distribution ever takes. */
  importSpecifier: (specifier: string) => Promise<unknown>;
  /** Whether this process is the compiled binary, which carries no packages. */
  isStandalone: () => boolean;
  /** Install the package on demand; returns the directory holding it. */
  provision: (pkg: SurfacePackage) => Promise<string>;
  /** Import the specifier out of a provisioned directory. */
  importFromStore: (installRoot: string, specifier: string) => Promise<unknown>;
}

function withImportDefaults(
  overrides: Partial<SurfaceImportDependencies>
): SurfaceImportDependencies {
  return {
    importSpecifier: overrides.importSpecifier ?? ((specifier) => import(specifier)),
    isStandalone: overrides.isStandalone ?? (() => isCompiledStandalone()),
    provision: overrides.provision ?? ((pkg) => provisionSurfacePackage(pkg)),
    importFromStore: overrides.importFromStore ?? importFromSurfaceStore,
  };
}

/**
 * Whether the import failed because nothing answered to the specifier.
 *
 * Node reports this as a code; Bun's compiled runtime words it as a resolution
 * failure and does not always carry one. Anything else — a package that exists
 * and threw while evaluating, say — must propagate untouched, since installing
 * a second copy of it would not help and would hide the real error.
 */
function isUnresolvedSpecifier(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  const message = (error as { message?: string } | undefined)?.message ?? '';
  return /Cannot find (module|package)|Could not resolve/i.test(message);
}

/**
 * Import a mounted surface, provisioning it first if this binary has to.
 *
 * On npm — every install, every CI runner, every test in this repo — the first
 * `import()` resolves and this returns exactly what `import(specifier)` returns.
 * Nothing below the `catch` runs, and no directory is created.
 *
 * The compiled standalone binary is the one caller that falls through: it is a
 * single file with no `node_modules`, so a mounted SDK has to be installed
 * before it can be imported (#1795). Only a specifier this CLI pins is eligible
 * — a caller naming something else (the end-to-end test mounts product builds
 * by absolute path) gets its original error back.
 */
export async function importProductSurface(
  specifier: string,
  overrides: Partial<SurfaceImportDependencies> = {}
): Promise<unknown> {
  const deps = withImportDefaults(overrides);
  try {
    return await deps.importSpecifier(specifier);
  } catch (error) {
    const pkg = SURFACE_PACKAGES[specifier];
    if (!pkg || !isUnresolvedSpecifier(error) || !deps.isStandalone()) throw error;
    const installRoot = await deps.provision(pkg);
    try {
      return await deps.importFromStore(installRoot, specifier);
    } catch (storeError) {
      // The package is on disk now, so "not installed" — what the generic
      // handler would say about an ERR_MODULE_NOT_FOUND — is simply false, and
      // sends the operator to reinstall something already there.
      if (!isUnresolvedSpecifier(storeError)) throw storeError;
      throw new SurfaceProvisionError(
        `${pkg.name} is installed at ${installRoot}, but this build cannot import it from there.\n` +
          `${describeError(storeError)}`,
        { cause: storeError }
      );
    }
  }
}

/** The only part of the optional Relayhistory cloud client this module uses. */
interface RelayhistoryCloudClientModule {
  createRelayhistoryCloudClient: (options: { baseUrl: string; token: string }) => unknown;
}

/**
 * Specifier for the optional cloud client.
 *
 * Indirected through a variable on purpose. `@relayhistory/cloud-client` is an
 * `optionalDependency`, but TypeScript still resolves a literal specifier
 * inside `await import(...)` and fails the build with TS2307 wherever the
 * package is absent — which is every CI runner until it is published. The
 * try/catch already covers its runtime absence; this covers compile time.
 */
const RELAYHISTORY_CLOUD_CLIENT = '@relayhistory/cloud-client';

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
    const module = (await import(RELAYHISTORY_CLOUD_CLIENT)) as RelayhistoryCloudClientModule;
    return { cloud: module.createRelayhistoryCloudClient({ baseUrl, token }) };
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
 * The package Node says it could not find, when it says so.
 *
 * ERR_MODULE_NOT_FOUND covers two different situations and the code alone does
 * not separate them:
 *
 *   Cannot find package '@relayfile/sdk' imported from …   -> genuinely absent
 *   Cannot find module '/abs/path/…/dist/index.js'         -> present, incomplete
 *
 * The second happens while an install is still writing, and reporting it as
 * "not installed" sends the operator to reinstall something already there.
 */
function missingPackageFrom(error: unknown): string | undefined {
  const message = (error as { message?: string } | undefined)?.message ?? '';
  return /Cannot find package '([^']+)'/.exec(message)?.[1];
}

/**
 * Whether Node named a file rather than a package.
 *
 * Detected positively, not by the absence of a package name: an error shape
 * this does not recognise should fall through to the plain "not installed"
 * advice, which is right far more often than "incomplete" would be.
 */
function missingFileFrom(error: unknown): string | undefined {
  const message = (error as { message?: string } | undefined)?.message ?? '';
  return /Cannot find module '(\/[^']+)'/.exec(message)?.[1];
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

  // Provisioning already composed the operator-facing text — which package,
  // which directory, and what to do about it. Re-describing it here would only
  // bury that behind a second framing.
  if (code === PROVISION_ERROR_CODE) {
    return `\`agent-relay ${definition.as}\` could not be prepared.\n${describeError(error)}`;
  }

  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    const missing = missingPackageFrom(error);

    // A dependency of the product, not the product: reinstalling the product
    // alone would not fix it, and naming the wrong package wastes the operator.
    if (missing !== undefined && missing !== packageName) {
      return (
        `\`agent-relay ${definition.as}\` could not load ${packageName}: ` +
        `it depends on ${missing}, which is not installed.\n` +
        `Reinstall agent-relay to repair the dependency tree.`
      );
    }

    // Node named a file rather than a package, so the package directory exists
    // but its contents do not. An interrupted or concurrent install looks like
    // this, and it resolves itself once the install finishes.
    if (missingFileFrom(error) !== undefined) {
      return (
        `\`agent-relay ${definition.as}\` could not load ${packageName}: ` +
        `it is installed but incomplete.\n` +
        `If an install is running, wait for it to finish and retry; ` +
        `otherwise reinstall agent-relay.\n${describeError(error)}`
      );
    }

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
    importModule: overrides.importModule ?? importProductSurface,
    io: overrides.io ?? processIo(),
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
