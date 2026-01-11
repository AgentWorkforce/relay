import { db } from '../db/index.js';
import { getProvisioner } from '../provisioner/index.js';

const PROVIDER_ENV_VARS: Record<string, string> = {
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

export async function setProviderApiKeyEnv(
  userId: string,
  provider: string,
  apiKey: string
): Promise<{ updated: number; skipped: number }> {
  const envVarName = PROVIDER_ENV_VARS[provider];
  if (!envVarName) {
    return { updated: 0, skipped: 0 };
  }

  const workspaces = await db.workspaces.findByUserId(userId);
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
