import { authorizedApiFetch, ensureAuthenticated } from './auth.js';
import { defaultApiUrl, type CloudAgentUsageRecord } from './types.js';

export type ListAccountUsageOptions = {
  apiUrl?: string;
};

export async function listAccountUsage(
  options: ListAccountUsageOptions = {}
): Promise<CloudAgentUsageRecord[]> {
  const apiUrl = options.apiUrl || defaultApiUrl();
  const auth = await ensureAuthenticated(apiUrl);
  const { response } = await authorizedApiFetch(auth, '/api/v1/cloud-agents?usage=1', {
    method: 'GET',
  });

  const payload = (await response.json().catch(() => null)) as {
    agents?: CloudAgentUsageRecord[];
    error?: string;
  } | null;

  if (!response.ok || !Array.isArray(payload?.agents)) {
    throw new Error(
      payload?.error || `Failed to load account usage: ${response.status} ${response.statusText}`
    );
  }

  return payload.agents;
}
