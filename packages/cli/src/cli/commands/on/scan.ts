import path from 'node:path';
import { compileDotfiles, discoverAgents, hasDotfiles, parseDotfiles } from './dotfiles.js';

interface ScanDependencies {
  projectDir?: string;
  workspace?: string;
  log?: (...args: unknown[]) => void;
}

function defaultLog(...args: unknown[]): void {
  console.log(...args);
}

function resolveWorkspaceName(projectDir: string, explicit?: string): string {
  return explicit ?? path.basename(projectDir);
}

export async function scanPermissions(deps: ScanDependencies = {}): Promise<void> {
  const projectDir = path.resolve(deps.projectDir ?? process.cwd());
  const workspace = resolveWorkspaceName(projectDir, deps.workspace);
  const log = deps.log ?? defaultLog;

  const hasDotfileConfig = hasDotfiles(projectDir);
  const discoveredAgents = discoverAgents(projectDir);
  const agents = discoveredAgents.length > 0 ? discoveredAgents : ['default-agent'];

  log(`Discovered agents: ${agents.join(', ')}`);
  if (!hasDotfileConfig && agents.length === 1 && agents[0] === 'default-agent') {
    log('No dotfile patterns found; defaulting to full readwrite workspace visibility.');
  }
  if (agents.length === 0) {
    return;
  }

  for (const agentName of agents) {
    const parsed = parseDotfiles(projectDir, agentName);
    const compiled = compileDotfiles(projectDir, agentName, workspace);

    const ignored = parsed.ignoredPatterns;
    const readonly = parsed.readonlyPatterns;
    const writable = compiled.readwritePaths;

    log(`\n[${agentName}]`);
    log(`Ignored patterns (${ignored.length}):`);
    if (ignored.length > 0) {
      for (const pattern of ignored) {
        log(`  - ${pattern}`);
      }
    } else {
      log('  - (none)');
    }

    log(`Readonly patterns (${readonly.length}):`);
    if (readonly.length > 0) {
      for (const pattern of readonly) {
        log(`  - ${pattern}`);
      }
    } else {
      log('  - (none)');
    }

    log(`Writable files (${writable.length}):`);
    if (writable.length > 0) {
      for (const file of writable) {
        log(`  - ${file}`);
      }
    } else {
      log('  - (none)');
    }
  }
}
