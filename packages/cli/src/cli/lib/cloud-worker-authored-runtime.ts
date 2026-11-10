import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SURFACE_PACKAGES } from '../commands/product-surfaces.js';
import { isCompiledStandalone, provisionSurfacePackage } from './product-surface-store.js';

async function installedSurfaceRoot(): Promise<string> {
  let sdkEntry: string;
  try {
    sdkEntry = fileURLToPath(import.meta.resolve('@relayflows/sdk/relay-cli'));
  } catch (error) {
    if (!isCompiledStandalone()) throw error;
    const root = await provisionSurfacePackage(SURFACE_PACKAGES['@relayflows/sdk/relay-cli']!);
    sdkEntry = path.join(root, 'node_modules', '@relayflows', 'sdk', 'dist', 'relay-cli.js');
  }
  // Resolve through the pinned SDK, including npm's nested dependency layout.
  const runtime = createRequire(pathToFileURL(sdkEntry)).resolve('@relayflows/surface/runtime');
  for (let root = path.dirname(runtime); ; root = path.dirname(root)) {
    const manifest = await readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}');
    if (JSON.parse(manifest).name === '@relayflows/surface') return root;
    if (path.dirname(root) === root) throw new Error('Cannot locate the installed Relayflows Surface.');
  }
}

/** Give an isolated authored assignment the CLI's pinned Surface when it has none. */
export async function prepareWorkerAuthoredRuntime(workflowPath: string): Promise<void> {
  const require = createRequire(pathToFileURL(workflowPath));
  try {
    require.resolve('@relayflows/surface/runtime');
    return; // The SDK validates the assignment's own Surface; never replace it.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
  }

  // A broken/incompatible supplied package must fail as supplied, rather than
  // silently changing the authored flow's dependency and authority.
  for (const directory of require.resolve.paths('@relayflows/surface') ?? []) {
    if (
      await lstat(path.join(directory, '@relayflows', 'surface')).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      })
    )
      throw new Error('The assignment supplies a Surface package that cannot resolve its runtime.');
  }

  const root = await installedSurfaceRoot();
  let directory = path.dirname(workflowPath);
  for (const part of ['node_modules', '@relayflows']) {
    directory = path.join(directory, part);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    // Do not write through a code archive's link into another dependency tree.
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('The assignment runtime directory must be a directory, not a link.');
    }
  }
  // No overwrite on an existing path or a concurrent creator. Windows junctions
  // provide the same package-directory resolution without symlink privileges.
  await symlink(root, path.join(directory, 'surface'), process.platform === 'win32' ? 'junction' : 'dir');
}
