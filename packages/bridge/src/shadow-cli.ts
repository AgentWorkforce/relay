import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandExists } from '@agent-relay/utils/command-resolver';

const execFileAsync = promisify(execFile);

export type ShadowCli = 'claude' | 'codex';
export type ShadowMode = 'subagent' | 'process';

export interface ShadowCliSelection {
  cli: ShadowCli;
  /** Actual command to execute when spawning a process */
  command: string;
  mode: ShadowMode;
}

/** Normalize CLI name to a supported identifier */
function normalizeCli(cli: string | undefined): ShadowCli | null {
  if (!cli) return null;
  const base = cli.trim().split(' ')[0]; // Strip any args
  const [command] = base.split(':'); // Handle variants like claude:opus
  const lower = command.toLowerCase();

  if (lower.startsWith('claude')) return 'claude';
  if (lower === 'codex' || lower === 'opencode') return 'codex';

  return null;
}

async function isCommandAuthenticated(command: string): Promise<boolean> {
  if (!commandExists(command)) return false;

  try {
    await execFileAsync(command, ['--version'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

async function detectAuthenticatedCommand(cli: ShadowCli): Promise<string | null> {
  const candidates = cli === 'claude' ? ['claude'] : ['codex', 'opencode'];

  for (const candidate of candidates) {
    if (await isCommandAuthenticated(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Select the shadow CLI and execution mode based on the primary agent's CLI.
 * - Claude/OpenCode primaries run shadows as subagents (Task tool)
 * - Others fall back to spawning a process using an authenticated CLI
 */
export async function selectShadowCli(
  primaryCli: string,
  options?: { preferredShadowCli?: string }
): Promise<ShadowCliSelection> {
  const primary = normalizeCli(primaryCli);
  const preferred = normalizeCli(options?.preferredShadowCli);

  // Native subagent support for Claude/OpenCode primaries
  if (primary) {
    return {
      cli: primary,
      command: primary === 'claude' ? 'claude' : 'codex',
      mode: 'subagent',
    };
  }

  // Process-mode fallback for non-supporting primaries
  const fallbackOrder: ShadowCli[] = [];
  if (preferred) fallbackOrder.push(preferred);
  fallbackOrder.push('claude', 'codex');

  const seen = new Set<ShadowCli>();
  for (const candidate of fallbackOrder) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const authenticatedCommand = await detectAuthenticatedCommand(candidate);
    if (authenticatedCommand) {
      return {
        cli: candidate,
        command: authenticatedCommand,
        mode: 'process',
      };
    }
  }

  throw new Error('No shadow-capable CLI authenticated. Install Claude or OpenCode (codex) and try again.');
}
