/**
 * Normalize the supported workspace-key environment aliases into the canonical
 * `RELAY_WORKSPACE_KEY` variable while preserving their documented precedence.
 *
 * @returns The first non-blank workspace key, or `undefined` when none is set.
 */
export function promoteWorkspaceKeyEnvAlias(env: NodeJS.ProcessEnv): string | undefined {
  const workspaceKey = [env.RELAY_WORKSPACE_KEY, env.AGENT_RELAY_WORKSPACE_KEY, env.RELAY_API_KEY]
    .map((value) => value?.trim())
    .find(Boolean);
  if (workspaceKey && !env.RELAY_WORKSPACE_KEY?.trim()) {
    env.RELAY_WORKSPACE_KEY = workspaceKey;
  }
  return workspaceKey;
}
