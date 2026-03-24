/**
 * Cloud workflow runner — submits workflows to AgentWorkforce cloud API
 * and polls for completion.
 */
import type { RelayYamlConfig, WorkflowRunRow, WorkflowRunStatus } from './types.js';

export interface CloudRunOptions {
  cloudApiUrl: string;
  cloudApiToken: string;
  envSecrets?: Record<string, string>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onStatusChange?: (status: WorkflowRunStatus, runId: string) => void;
}

export async function runInCloud(config: RelayYamlConfig, options: CloudRunOptions): Promise<WorkflowRunRow> {
  const { cloudApiUrl, cloudApiToken, envSecrets, pollIntervalMs = 3000, timeoutMs = 1800000 } = options;
  const baseUrl = cloudApiUrl.replace(/\/$/, '');

  const { stringify: stringifyYaml } = await import('yaml');
  const yamlStr = stringifyYaml(config);

  const submitRes = await fetch(`${baseUrl}/api/v1/workflows/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cloudApiToken}` },
    body: JSON.stringify({ workflow: yamlStr, fileType: 'yaml' as const, ...(envSecrets ? { envSecrets } : {}) }),
  });
  if (!submitRes.ok) throw new Error(`Cloud submit failed (${submitRes.status}): ${await submitRes.text()}`);

  const { runId } = (await submitRes.json()) as { runId: string; sandboxId: string; status: string };
  const deadline = Date.now() + timeoutMs;
  let lastStatus: WorkflowRunStatus = 'pending';

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const statusRes = await fetch(`${baseUrl}/api/v1/workflows/runs/${runId}`, {
      headers: { 'Authorization': `Bearer ${cloudApiToken}` },
    });
    if (!statusRes.ok) continue;

    const data = (await statusRes.json()) as { runId: string; status: WorkflowRunStatus; error?: string; createdAt?: string; updatedAt?: string };
    if (data.status !== lastStatus) { lastStatus = data.status; options.onStatusChange?.(lastStatus, runId); }

    if (data.status === 'completed' || data.status === 'failed') {
      return {
        id: runId, workspaceId: '', workflowName: config.name ?? 'cloud-workflow',
        pattern: (config.swarm?.pattern as any) ?? 'dag', status: data.status, config,
        startedAt: data.createdAt ?? new Date().toISOString(),
        completedAt: data.updatedAt ?? new Date().toISOString(),
        error: data.error, createdAt: data.createdAt ?? new Date().toISOString(),
        updatedAt: data.updatedAt ?? new Date().toISOString(),
      };
    }
  }
  throw new Error(`Cloud workflow timed out after ${timeoutMs}ms (runId: ${runId})`);
}
