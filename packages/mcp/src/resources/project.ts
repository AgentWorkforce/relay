/**
 * Project Resource
 *
 * Provides current project configuration as an MCP resource.
 * URI: relay://project
 */

import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client.js';

export const projectResource: Resource = {
  uri: 'relay://project',
  name: 'Project Info',
  description: 'Current relay project configuration',
  mimeType: 'application/json',
};

export async function getProjectResource(client: RelayClient): Promise<string> {
  const status = await client.getStatus();
  return JSON.stringify(
    {
      project: status.project,
      socketPath: status.socketPath,
      daemonVersion: status.daemonVersion,
    },
    null,
    2
  );
}
