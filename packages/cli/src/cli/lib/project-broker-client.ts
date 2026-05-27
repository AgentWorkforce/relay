import path from 'node:path';

import { AgentRelayClient } from '@agent-relay/driver';

export function getProjectBrokerConnectionPath(projectRoot: string): string {
  return path.join(projectRoot, '.agent-relay', 'connection.json');
}

export function connectProjectBrokerClient(projectRoot: string): AgentRelayClient {
  return AgentRelayClient.connect({
    cwd: projectRoot,
    connectionPath: getProjectBrokerConnectionPath(projectRoot),
  });
}
