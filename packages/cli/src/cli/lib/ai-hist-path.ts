/**
 * Resolve the `ai-hist` Rust binary at runtime.
 *
 * Mirrors the broker's resolution model so Reflex capture works on a plain
 * `agent-relay` install with no extra setup: the binary ships as a
 * per-platform optional-dependency package (`ai-hist-bin-<platform>-<arch>`),
 * auto-installed by npm, and is found here.
 *
 * Search order:
 *   1. `$AI_HIST_RUST_BIN` explicit override
 *   2. the bundled per-platform optional-dep package (primary production path)
 *   3. the install.sh location (`~/.local/share/ai-hist/ai-hist-rust-bin`)
 *   4. `ai-hist` on `PATH` (last resort; spawn surfaces ENOENT as a no-op)
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BINARY_NAME = 'ai-hist';

/** npm package that carries the prebuilt binary for a given platform/arch. */
export function aiHistOptionalDepName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  return `ai-hist-bin-${platform}-${arch}`;
}

function resolutionReferences(): string[] {
  const refs: string[] = [];
  try {
    // ESM: locate this module so it can resolve its sibling optional dep.
    refs.push(fileURLToPath(import.meta.url));
  } catch {
    /* not ESM / unavailable */
  }
  if (process.argv[1]) refs.push(process.argv[1]);
  refs.push(join(process.cwd(), 'package.json'));
  return [...new Set(refs)];
}

/** The binary inside the platform optional-dep package, if installed. */
function bundledBinaryPath(): string | null {
  const pkg = aiHistOptionalDepName();
  const file = process.platform === 'win32' ? `${BINARY_NAME}.exe` : BINARY_NAME;
  for (const ref of resolutionReferences()) {
    try {
      const pkgJson = createRequire(ref).resolve(`${pkg}/package.json`);
      const bin = join(dirname(pkgJson), 'bin', file);
      if (existsSync(bin)) return bin;
    } catch {
      /* try the next reference */
    }
  }
  return null;
}

/**
 * Resolve the ai-hist binary. Always returns a command/path; when nothing is
 * discovered it falls back to `ai-hist` and lets spawn surface ENOENT (which
 * the capture loop treats as a no-op).
 */
export function getAiHistBinaryPath(): string {
  const override = process.env.AI_HIST_RUST_BIN;
  if (override && existsSync(resolve(override))) return resolve(override);

  const bundled = bundledBinaryPath();
  if (bundled) return bundled;

  const installed = join(homedir(), '.local', 'share', 'ai-hist', 'ai-hist-rust-bin');
  if (existsSync(installed)) return installed;

  return BINARY_NAME;
}
