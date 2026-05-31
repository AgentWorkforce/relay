import path from 'node:path';

import { RuntimeClient } from '@agent-relay/runtime';

export function getProjectBrokerConnectionPath(projectRoot: string): string {
  return path.join(projectRoot, '.agent-relay', 'connection.json');
}

export function connectProjectBrokerClient(projectRoot: string): RuntimeClient {
  return RuntimeClient.connect({
    cwd: projectRoot,
    connectionPath: getProjectBrokerConnectionPath(projectRoot),
  });
}
