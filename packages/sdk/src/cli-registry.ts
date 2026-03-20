/**
 * Consolidated CLI registry — single source of truth for all supported
 * agent CLI metadata: binary names, non-interactive args, bypass flags,
 * and well-known install paths.
 *
 * Consumers: runner.ts (buildNonInteractiveCommand, resolveCursorCli),
 * spawn-from-env.ts (BYPASS_FLAGS), cli-resolver.ts (path resolution).
 *
 * NOTE: The Rust PTY spawner (src/pty.rs) maintains its own PATH fallback.
 * When updating `COMMON_SEARCH_PATHS` here, also update the Rust fallback
 * in `resolve_command_path()` at src/pty.rs:53-67.
 */

import type { AgentCli } from './workflows/types.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CliDefinition {
  /** Binary name(s) to try, in order of preference */
  binaries: string[];
  /** Build non-interactive mode args for a one-shot task */
  nonInteractiveArgs: (task: string, extraArgs?: string[]) => string[];
  /** Bypass flag for auto-approve / unattended mode */
  bypassFlag?: string;
  /** Bypass flag aliases (alternative forms accepted by the CLI) */
  bypassAliases?: string[];
  /** Extra install paths to check beyond PATH (resolved relative to $HOME) */
  searchPaths?: string[];
  /** When true, non-zero exit codes are not treated as failures (some CLIs exit non-zero on success) */
  ignoreExitCode?: boolean;
}

// ── Well-known install paths ───────────────────────────────────────────────

/**
 * Common install directories checked when PATH is empty or incomplete.
 * Paths containing `~` are expanded at resolution time.
 *
 * Keep in sync with the Rust fallback in src/pty.rs `resolve_command_path()`.
 */
export const COMMON_SEARCH_PATHS = [
  '~/.local/bin',
  '~/.opencode/bin',
  '~/.claude/local',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/homebrew/bin',
];

// ── Registry ───────────────────────────────────────────────────────────────

const CLI_REGISTRY: Record<AgentCli, CliDefinition> = {
  claude: {
    binaries: ['claude'],
    nonInteractiveArgs: (task, extra = []) => [
      '-p',
      '--dangerously-skip-permissions',
      task,
      ...extra,
    ],
    bypassFlag: '--dangerously-skip-permissions',
    searchPaths: ['~/.claude/local'],
  },
  codex: {
    binaries: ['codex'],
    nonInteractiveArgs: (task, extra = []) => ['exec', task, ...extra],
    bypassFlag: '--dangerously-bypass-approvals-and-sandbox',
    bypassAliases: ['--full-auto'],
    searchPaths: ['~/.local/bin'],
  },
  gemini: {
    binaries: ['gemini'],
    nonInteractiveArgs: (task, extra = []) => ['-p', task, ...extra],
    bypassFlag: '--yolo',
    bypassAliases: ['-y'],
  },
  opencode: {
    binaries: ['opencode'],
    nonInteractiveArgs: (task, extra = []) => ['run', task, ...extra],
    searchPaths: ['~/.opencode/bin'],
    ignoreExitCode: true,
  },
  droid: {
    binaries: ['droid'],
    nonInteractiveArgs: (task, extra = []) => ['exec', task, ...extra],
  },
  aider: {
    binaries: ['aider'],
    nonInteractiveArgs: (task, extra = []) => [
      '--message',
      task,
      '--yes-always',
      '--no-git',
      ...extra,
    ],
  },
  goose: {
    binaries: ['goose'],
    nonInteractiveArgs: (task, extra = []) => [
      'run',
      '--text',
      task,
      '--no-session',
      ...extra,
    ],
  },
  'cursor-agent': {
    binaries: ['cursor-agent'],
    nonInteractiveArgs: (task, extra = []) => [
      '--force',
      '-p',
      task,
      ...extra,
    ],
  },
  agent: {
    binaries: ['agent'],
    nonInteractiveArgs: (task, extra = []) => [
      '--force',
      '-p',
      task,
      ...extra,
    ],
  },
  cursor: {
    binaries: ['cursor-agent', 'agent'],
    nonInteractiveArgs: (task, extra = []) => [
      '--force',
      '-p',
      task,
      ...extra,
    ],
  },
};

/**
 * Get the CLI definition for a given CLI identifier.
 * Handles `cli:model` variants (e.g. `claude:opus`) by extracting the base CLI.
 */
export function getCliDefinition(cli: string): CliDefinition | undefined {
  const baseCli = cli.includes(':') ? cli.split(':')[0] : cli;
  return CLI_REGISTRY[baseCli as AgentCli];
}

/**
 * Get the full registry (read-only).
 */
export function getCliRegistry(): Readonly<Record<AgentCli, CliDefinition>> {
  return CLI_REGISTRY;
}
