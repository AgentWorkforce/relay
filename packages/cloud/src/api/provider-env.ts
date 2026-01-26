import { db } from '../db/index.js';
import { getProvisioner } from '../provisioner/index.js';

const PROVIDER_ENV_VARS: Record<string, string> = {
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * All providers that may have credential files on the workspace.
 * This includes CLI-based providers that store auth locally.
 */
const ALL_CREDENTIAL_PROVIDERS = [
  'anthropic', 'claude',
  'codex', 'openai',
  'google', 'gemini',
  'opencode',
  'droid', 'factory',
  'cursor',
];

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

/**
 * Clear provider credentials from workspace(s).
 * Deletes credential files and unsets environment variables.
 *
 * @param userId - User ID
 * @param provider - Provider name (e.g., 'google', 'anthropic', 'codex')
 * @param workspaceId - Workspace to clear credentials from
 */
export async function clearProviderCredentials(
  userId: string,
  provider: string,
  workspaceId: string
): Promise<{ cleared: boolean; error?: string }> {
  const envVarName = PROVIDER_ENV_VARS[provider];
  const needsCredentialFileClear = ALL_CREDENTIAL_PROVIDERS.includes(provider);

  // Get the workspace
  const workspace = await db.workspaces.findById(workspaceId);
  if (!workspace) {
    return { cleared: false, error: 'Workspace not found' };
  }

  if (!workspace.publicUrl) {
    // Workspace not running, credentials will be gone when it restarts anyway
    return { cleared: true };
  }

  // Clear environment variable if applicable
  if (envVarName && workspace.computeId) {
    const provisioner = getProvisioner();
    try {
      // Set to empty string to clear
      await provisioner.setWorkspaceEnvVars(workspace, { [envVarName]: '' });
    } catch (err) {
      console.warn(`[provider-env] Failed to clear env var ${envVarName} on workspace ${workspace.id}:`, err);
    }
  }

  // Delete credential files from workspace
  if (needsCredentialFileClear) {
    try {
      const response = await fetch(`${workspace.publicUrl}/api/credentials/apikey`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, provider }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        console.warn(
          `[provider-env] Failed to delete credential files for ${provider} on workspace ${workspace.id}: ${response.status}`,
          data
        );
        return { cleared: false, error: 'Failed to delete credential files on workspace' };
      }

      const data = await response.json() as { deletedPaths?: string[] };
      console.log(
        `[provider-env] Deleted ${provider} credentials for user ${userId} on workspace ${workspace.id}:`,
        data.deletedPaths
      );
    } catch (err) {
      console.warn(`[provider-env] Error deleting credential files for ${provider} on workspace ${workspace.id}:`, err);
      return { cleared: false, error: 'Error connecting to workspace' };
    }
  }

  return { cleared: true };
}
