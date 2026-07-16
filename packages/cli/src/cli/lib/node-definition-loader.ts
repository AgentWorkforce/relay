import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FleetNodeDefinition } from '@agent-relay/fleet';

const JITI_NODE_DEFINITION_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * Deterministic order in which `discoverNodeConfigPath` looks for an implicit
 * node definition file in the working directory. TypeScript variants are
 * preferred over compiled JS.
 */
const NODE_CONFIG_BASENAMES = [
  'agent-relay.ts',
  'agent-relay.tsx',
  'agent-relay.mts',
  'agent-relay.cts',
  'agent-relay.js',
  'agent-relay.mjs',
  'agent-relay.cjs',
] as const;

/**
 * Resolve the node definition config file for `relay node up`.
 *
 * @param cwd - Working directory to search for an implicit config file.
 * @param explicit - Optional explicit path from `--config`; when present it must
 *   exist or a clear error is thrown.
 * @returns The resolved absolute config path, or `undefined` when no implicit
 *   file is found and no explicit path was given.
 */
export function discoverNodeConfigPath(cwd: string, explicit?: string): string | undefined {
  const explicitPath = explicit?.trim();
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath);
    if (!isFile(resolved)) {
      throw new Error(`Node config file not found: ${explicitPath}`);
    }
    return resolved;
  }

  for (const basename of NODE_CONFIG_BASENAMES) {
    const candidate = path.join(cwd, basename);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an `agent-relay.py` node definition in the project root, served by
 * `relay node up` as a supervised Python child process.
 * @param cwd - Project root to search.
 * @returns The absolute path to `agent-relay.py`, or `undefined` when absent.
 */
export function discoverPythonNodeConfigPath(cwd: string): string | undefined {
  const candidate = path.join(cwd, 'agent-relay.py');
  return isFile(candidate) ? candidate : undefined;
}

/**
 * Load and validate a fleet node definition from a TS/JS file.
 * @param file - Path to a node definition file default-exporting `defineNode(...)`.
 */
export async function loadNodeDefinition(file: string): Promise<FleetNodeDefinition> {
  const absolutePath = path.resolve(file);
  const loaded = await importNodeDefinition(absolutePath);
  const definition = unwrapNodeDefinitionExport(loaded);
  if (!isFleetNodeDefinitionLike(definition)) {
    throw new Error(`Fleet node file ${absolutePath} must default-export defineNode(...)`);
  }
  return definition;
}

function unwrapNodeDefinitionExport(loaded: unknown): unknown {
  let candidate = loaded;
  for (let depth = 0; depth < 3; depth += 1) {
    if (isFleetNodeDefinitionLike(candidate)) {
      return candidate;
    }
    if (!candidate || typeof candidate !== 'object' || !('default' in candidate)) {
      return candidate;
    }
    candidate = (candidate as { default?: unknown }).default;
  }
  return candidate;
}

function isFleetNodeDefinitionLike(value: unknown): value is FleetNodeDefinition {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { __agentRelayFleetNode?: unknown }).__agentRelayFleetNode === true
  );
}

async function importNodeDefinition(absolutePath: string): Promise<unknown> {
  if (!JITI_NODE_DEFINITION_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
    try {
      return (await import(pathToFileURL(absolutePath).href)) as unknown;
    } catch (error) {
      if (!shouldFallbackToJiti(error)) {
        throw error;
      }

      try {
        return await importNodeDefinitionWithJiti(absolutePath);
      } catch {
        throw error;
      }
    }
  }

  return importNodeDefinitionWithJiti(absolutePath);
}

function shouldFallbackToJiti(error: unknown): boolean {
  if (isBunRuntime()) {
    return false;
  }
  return error instanceof SyntaxError && getErrorCode(error) !== 'ERR_MODULE_NOT_FOUND';
}

function isBunRuntime(): boolean {
  return typeof (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun === 'string';
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function importNodeDefinitionWithJiti(absolutePath: string): Promise<unknown> {
  const { createJiti } = await import('jiti');
  const jiti = createJiti(pathToFileURL(process.cwd()).href, {
    interopDefault: true,
  });
  return jiti.import(absolutePath, { default: true }) as Promise<unknown>;
}
