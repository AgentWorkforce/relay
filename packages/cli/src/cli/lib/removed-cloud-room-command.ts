/**
 * What a removed `cloud room` command prints instead of running.
 * @param verb - The command path the user ran, e.g. `cloud room invite`
 * @returns The removal notice with the replacement
 */
export function removedCloudRoomCommandMessage(verb: string): string {
  return (
    `'relay ${verb}' was removed: Agent Relay Cloud no longer serves rooms. ` +
    'Use Relay Connect to share a session instead. The host creates a link with the ' +
    "Agent Relay MCP tool 'create_connect', and a guest joins with 'join_connect' or " +
    "'npx -y @agent-relay/connect join <link>'."
  );
}
