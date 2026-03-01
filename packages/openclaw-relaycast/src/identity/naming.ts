/**
 * Build the relay agent name from workspace ID and claw name.
 */
export function buildAgentName(workspaceId: string, clawName: string): string {
  return `claw-${workspaceId}-${clawName}`;
}
