import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Discover project root by locating a .agent-relay directory.
 */
export function discoverProjectRoot(): string | null {
  const socketEnv = process.env.RELAY_SOCKET;
  if (socketEnv) {
    const match = socketEnv.match(/^(.+)\/\.agent-relay\/relay\.sock$/);
    if (match) {
      return match[1];
    }
  }

  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, '.agent-relay'))) {
      return dir;
    }
    dir = dirname(dir);
  }

  return null;
}
