import { RelayCast } from '@relaycast/sdk';

import { relaycastWorkspaceTelemetryOptions } from '../lib/relaycast-telemetry.js';
import type { RegistrationSession } from './types.js';

/** Create a new RelayCast workspace, returning the raw provisioning payload. */
export async function createWorkspace(name: string, baseUrl?: string): Promise<Record<string, unknown>> {
  return (await RelayCast.createWorkspace(name, {
    baseUrl,
    ...relaycastWorkspaceTelemetryOptions(),
  })) as Record<string, unknown>;
}

/** Extract a workspace key from a provisioning payload, tolerating naming variants. */
export function extractWorkspaceKey(payload: Record<string, unknown>): string | undefined {
  const data =
    payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
  const value =
    payload.workspaceKey ??
    payload.workspace_key ??
    payload.apiKey ??
    payload.api_key ??
    data.workspaceKey ??
    data.workspace_key ??
    data.apiKey ??
    data.api_key;

  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Extract a workspace name from a provisioning payload, falling back to `fallback`. */
export function extractWorkspaceName(payload: Record<string, unknown>, fallback: string): string {
  const data =
    payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};
  const value = payload.workspaceName ?? payload.workspace_name ?? payload.name ?? data.workspaceName;
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** Throw a descriptive error when the session has no workspace key configured. */
export function requireWorkspaceKey(session: RegistrationSession): void {
  if (session.workspaceKey) {
    return;
  }

  throw new Error(
    'Workspace key not configured. Call "create_workspace" first, or "set_workspace_key" if someone shared a workspace key.'
  );
}
