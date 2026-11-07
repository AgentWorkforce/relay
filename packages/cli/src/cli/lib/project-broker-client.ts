import path from 'node:path';

import { HarnessDriverClient } from '@agent-relay/harness-driver';

export function getProjectBrokerConnectionPath(projectRoot: string): string {
  return path.join(projectRoot, '.agentworkforce/relay', 'connection.json');
}

export function connectProjectBrokerClient(projectRoot: string): HarnessDriverClient {
  return HarnessDriverClient.connect({
    cwd: projectRoot,
    connectionPath: getProjectBrokerConnectionPath(projectRoot),
  });
}
