/**
 * What a removed broker verb prints instead of running.
 * @param verb - The command path the user ran, e.g. `node up`
 * @returns The removal notice with the replacement
 */
export function removedBrokerCommandMessage(verb: string): string {
  return (
    `'relay ${verb}' was removed together with the local broker. ` +
    "Run 'relay init' to set up and start the Agent Relay core on this machine: it delivers messages " +
    'and spawns, lists and releases agents, through the Agent Relay MCP spawn tools or the desktop app.'
  );
}
