import { readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Patch OpenClaw's compiled dist JS files to replace hardcoded identity constants.
 *
 * FRAGILE: This is a best-effort operation. OpenClaw bakes Claude defaults into
 * its compiled output. These patterns may change between OpenClaw versions.
 * Prefer runtime identity enforcement (SOUL.md, runtime-identity.json, identity
 * preamble in bridge) over relying on this patch.
 *
 * Known hardcoded constants (as of OpenClaw ~0.x):
 *   - DEFAULT_MODEL = "claude-opus-4-6"
 *   - KILOCODE_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.6"
 *   - KILOCODE_DEFAULT_MODEL_NAME = "Claude Opus 4.6"
 *   - "Claude Code" branding
 *
 * @param distDir - Path to OpenClaw's dist directory (e.g. /usr/lib/node_modules/openclaw/dist)
 * @param modelRef - Full model reference (e.g. "openai-codex/gpt-5.3-codex")
 * @returns Number of files patched, or 0 if dist not found or patching skipped
 */
export async function patchOpenClawDist(distDir: string, modelRef: string): Promise<number> {
  if (!existsSync(distDir)) {
    process.stderr.write(`[patch] OpenClaw dist not found at ${distDir}, skipping\n`);
    return 0;
  }

  // Extract bare model ID (e.g. "gpt-5.3-codex" from "openai-codex/gpt-5.3-codex")
  const modelId = modelRef.includes('/') ? modelRef.split('/').pop()! : modelRef;

  const replacements: [RegExp, string][] = [
    [/claude-opus-4-6/g, modelId],
    [/claude-opus-4\.6/g, modelId],
    [/anthropic\/claude-opus-4\.6/g, modelRef],
    [/Claude Opus 4\.6/g, modelRef],
    [/Claude Code/g, 'OpenClaw Agent'],
  ];

  let patchedCount = 0;

  try {
    async function walkAndPatch(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkAndPatch(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          try {
            let content = await readFile(fullPath, 'utf8');
            let modified = false;

            for (const [pattern, replacement] of replacements) {
              const newContent = content.replace(pattern, replacement);
              if (newContent !== content) {
                content = newContent;
                modified = true;
              }
            }

            if (modified) {
              await writeFile(fullPath, content, 'utf8');
              patchedCount++;
            }
          } catch (err) {
            // Individual file patch failure is non-fatal
            process.stderr.write(
              `[patch] Warning: could not patch ${fullPath}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }
    }

    await walkAndPatch(distDir);
  } catch (err) {
    // Entire patching failure is non-fatal — runtime identity enforcement is the primary defense
    process.stderr.write(
      `[patch] Warning: dist patching failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  if (patchedCount > 0) {
    process.stderr.write(`[patch] Patched ${patchedCount} file(s) in ${distDir}\n`);
  }

  return patchedCount;
}

/**
 * Clear JIT cache (/tmp/jiti/) which may contain unpatched constants.
 */
export async function clearJitCache(): Promise<void> {
  try {
    await rm('/tmp/jiti', { recursive: true, force: true });
  } catch {
    // Ignore — cache may not exist
  }
}
