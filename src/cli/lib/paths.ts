import path from 'node:path';

export function getWorkerLogsDir(projectRoot: string): string {
  return path.join(projectRoot, '.agent-relay', 'worker-logs');
}
