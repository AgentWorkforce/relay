import { db } from '../db/index.js';
import { getProvisioner } from '../provisioner/index.js';

const PROVIDER_ENV_VARS: Record<string, string> = {
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * Set provider API key as environment variable on workspace(s)
 *
 * @param userId - User ID
 * @param provider - Provider name (e.g., 'google', 'gemini')
 * @param apiKey - API key to set
 * @param workspaceId - Optional: specific workspace to update. If not provided, updates all user workspaces (legacy behavior)
 */
export async function setProviderApiKeyEnv(
  userId: string,
  provider: string,
  apiKey: string,
  workspaceId?: string
): Promise<{ updated: number; skipped: number }> {
  const envVarName = PROVIDER_ENV_VARS[provider];
  if (!envVarName) {
    return { updated: 0, skipped: 0 };
  }

  // If workspaceId is provided, only update that workspace
  // Otherwise, update all user workspaces (legacy behavior)
  let workspaces;
  if (workspaceId) {
    const workspace = await db.workspaces.findById(workspaceId);
    workspaces = workspace ? [workspace] : [];
  } else {
    workspaces = await db.workspaces.findByUserId(userId);
  }

  if (workspaces.length === 0) {
    return { updated: 0, skipped: 0 };
  }

  const provisioner = getProvisioner();
  const results = await Promise.all(
    workspaces.map(async (workspace) => {
      if (!workspace.computeId) {
        return 'skipped';
      }

      await provisioner.setWorkspaceEnvVars(workspace, { [envVarName]: apiKey });
      return 'updated';
    })
  );

  const updated = results.filter((result) => result === 'updated').length;
  return { updated, skipped: results.length - updated };
}
