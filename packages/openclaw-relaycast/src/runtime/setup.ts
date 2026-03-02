import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { normalizeModelRef } from '../identity/model.js';
import { convertCodexAuth } from '../auth/converter.js';
import { writeOpenClawConfig } from './openclaw-config.js';
import { patchOpenClawDist, clearJitCache } from './patch.js';
import {
  generateSoulMd,
  generateIdentityMd,
  ensureWorkspace,
} from '../identity/files.js';

export interface RuntimeSetupOptions {
  /** Raw model string (e.g. "gpt-5.3-codex"). Defaults to env OPENCLAW_MODEL. */
  model?: string;
  /** Agent name. Defaults to env OPENCLAW_NAME or AGENT_NAME. */
  name?: string;
  /** Workspace ID. Defaults to env OPENCLAW_WORKSPACE_ID. */
  workspaceId?: string;
  /** Agent role. Defaults to env OPENCLAW_ROLE. */
  role?: string;
  /** OpenClaw dist directory for patching. Defaults to /usr/lib/node_modules/openclaw/dist. */
  openclawDistDir?: string;
  /** Home directory. Defaults to $HOME. */
  homeDir?: string;
}

/**
 * Full runtime setup: auth conversion, config writing, identity files, dist patching, JIT cache clear.
 *
 * This replaces the inline node -e block + shell logic in start-claw.sh.
 * Call this before starting the OpenClaw gateway.
 */
export async function runtimeSetup(options: RuntimeSetupOptions = {}): Promise<{
  modelRef: string;
  agentName: string;
  workspaceId: string;
}> {
  const home = options.homeDir ?? process.env.HOME ?? '/home/node';
  const model = options.model ?? process.env.OPENCLAW_MODEL ?? 'openai-codex/gpt-5.3-codex';
  const name = options.name ?? process.env.OPENCLAW_NAME ?? process.env.AGENT_NAME ?? 'agent';
  const workspaceId = options.workspaceId ?? process.env.OPENCLAW_WORKSPACE_ID ?? 'unknown';
  const role = options.role ?? process.env.OPENCLAW_ROLE ?? 'general';
  // Resolve OpenClaw dist dir: try explicit, then known install locations
  const distDirCandidates = options.openclawDistDir
    ? [options.openclawDistDir]
    : [
        '/usr/lib/node_modules/openclaw/dist',    // Global npm (ClawRunner sandbox)
        '/app/dist',                                // Vanilla Docker image
        '/usr/local/lib/node_modules/openclaw/dist', // Global npm (macOS/other)
      ];
  const distDir = distDirCandidates.find((d) => existsSync(d)) ?? distDirCandidates[0];

  // 1. Convert codex auth
  const { preferredProvider } = await convertCodexAuth();
  const modelRef = normalizeModelRef(model, preferredProvider);

  // 2. Write openclaw.json config
  await writeOpenClawConfig({
    modelRef,
    openclawHome: join(home, '.openclaw'),
  });

  // 3. Write identity files in workspace
  const wsDir = join(home, '.openclaw', 'workspace');
  await ensureWorkspace({
    workspacePath: wsDir,
    workspaceId,
    clawName: name,
    role,
    modelRef,
  });

  // Remove BOOTSTRAP.md if present (agent is pre-configured)
  const bootstrapPath = join(wsDir, 'BOOTSTRAP.md');
  if (existsSync(bootstrapPath)) {
    await unlink(bootstrapPath);
  }

  // 4. Patch OpenClaw dist
  await patchOpenClawDist(distDir, modelRef);

  // 5. Clear JIT cache
  await clearJitCache();

  return { modelRef, agentName: name, workspaceId };
}
