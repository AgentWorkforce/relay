import { db } from '../db/index.js';
import { getProvisioner } from '../provisioner/index.js';

const PROVIDER_ENV_VARS: Record<string, string> = {
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * Providers that need credential files written to the workspace filesystem.
 * These providers have CLIs that read from files rather than just env vars.
 */
const PROVIDERS_NEEDING_CREDENTIAL_FILES = ['google', 'gemini'];

/**
 * Set provider API key as environment variable on workspace(s)
 * and write credential files for providers that need them.
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
  const needsCredentialFile = PROVIDERS_NEEDING_CREDENTIAL_FILES.includes(provider);

  // If no env var and no credential file needed, nothing to do
  if (!envVarName && !needsCredentialFile) {
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

      // Set environment variable if applicable
      if (envVarName) {
        await provisioner.setWorkspaceEnvVars(workspace, { [envVarName]: apiKey });
      }

      // Write credential file to workspace for providers that need it
      if (needsCredentialFile && workspace.publicUrl) {
        try {
          const response = await fetch(`${workspace.publicUrl}/api/credentials/apikey`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, provider, apiKey }),
          });

          if (!response.ok) {
            console.warn(`[provider-env] Failed to write credential file for ${provider} on workspace ${workspace.id}: ${response.status}`);
          } else {
            console.log(`[provider-env] Wrote ${provider} credential file for user ${userId} on workspace ${workspace.id}`);
          }
        } catch (err) {
          console.warn(`[provider-env] Error writing credential file for ${provider} on workspace ${workspace.id}:`, err);
          // Don't fail the whole operation if credential file write fails
        }
      }

      return 'updated';
    })
  );

  const updated = results.filter((result) => result === 'updated').length;
  return { updated, skipped: results.length - updated };
}
