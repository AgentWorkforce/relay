/**
 * Consolidated CLI registry — single source of truth for all supported
 * agent CLI metadata: binary names, non-interactive args, bypass flags,
 * and well-known install paths.
 *
 * Consumers: runner.ts (buildNonInteractiveCommand, resolveCursorCli),
 * spawn-from-env.ts (BYPASS_FLAGS), cli-resolver.ts (path resolution).
 *
 * NOTE: The Rust PTY spawner (crates/broker/src/pty.rs) maintains its own PATH fallback.
 * When updating `COMMON_SEARCH_PATHS` here, also update the Rust fallback
 * in `resolve_command_path()` at crates/broker/src/pty.rs.
 */

import type { HarnessDefinition, KnownAgentCli } from '@agent-relay/workflow-types';

// ── Types ──────────────────────────────────────────────────────────────────

export interface CliDefinition {
  /** Binary name(s) to try, in order of preference */
  binaries: string[];
  /** Build non-interactive mode args for a one-shot task */
  nonInteractiveArgs: (task: string, extraArgs?: string[]) => string[];
  /** Build model-selection args for a model id */
  modelArgs?: (model: string) => string[];
  /** Bypass flag for auto-approve / unattended mode */
  bypassFlag?: string;
  /** Bypass flag aliases (alternative forms accepted by the CLI) */
  bypassAliases?: string[];
  /** Extra install paths to check beyond PATH (resolved relative to $HOME) */
  searchPaths?: string[];
  /** When true, non-zero exit codes are not treated as failures (some CLIs exit non-zero on success) */
  ignoreExitCode?: boolean;
  /** Credential proxy provider used when credentials.proxy is enabled. */
  proxyProvider?: 'openai' | 'anthropic' | 'openrouter';
}

// ── Well-known install paths ───────────────────────────────────────────────

/**
 * Common install directories checked when PATH is empty or incomplete.
 * Paths containing `~` are expanded at resolution time.
 *
 * Keep in sync with the Rust fallback in crates/broker/src/pty.rs `resolve_command_path()`.
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

const DEFAULT_NON_INTERACTIVE_TEMPLATE = ['{task}', '{args}'] as const;
const DEFAULT_MODEL_ARGS_TEMPLATE = ['--model', '{model}'] as const;

const CLI_REGISTRY: Record<KnownAgentCli, CliDefinition> = {
  claude: {
    binaries: ['claude'],
    nonInteractiveArgs: (task, extra = []) => ['-p', '--dangerously-skip-permissions', task, ...extra],
    bypassFlag: '--dangerously-skip-permissions',
    searchPaths: ['~/.claude/local'],
  },
  codex: {
    binaries: ['codex'],
    nonInteractiveArgs: (task, extra = []) => [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      task,
      ...extra,
    ],
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
    nonInteractiveArgs: (task, extra = []) => ['--message', task, '--yes-always', '--no-git', ...extra],
  },
  goose: {
    binaries: ['goose'],
    nonInteractiveArgs: (task, extra = []) => ['run', '--text', task, '--no-session', ...extra],
  },
  'cursor-agent': {
    binaries: ['cursor-agent'],
    nonInteractiveArgs: (task, extra = []) => ['--force', '-p', task, ...extra],
  },
  agent: {
    binaries: ['agent'],
    nonInteractiveArgs: (task, extra = []) => ['--force', '-p', task, ...extra],
  },
  cursor: {
    binaries: ['cursor-agent', 'agent'],
    nonInteractiveArgs: (task, extra = []) => ['--force', '-p', task, ...extra],
  },
  api: {
    binaries: [],
    nonInteractiveArgs: (task) => [task],
  },
};

const USER_CLI_REGISTRY = new Map<string, CliDefinition>();
const USER_HARNESS_CONFIGS = new Map<string, HarnessDefinition>();

function normalizeCliKey(cli: string): string {
  const trimmed = cli.trim();
  if (!trimmed) {
    throw new Error('Harness name must be a non-empty string');
  }
  return trimmed.includes(':') ? trimmed.split(':')[0] : trimmed;
}

function lookupCliKey(cli: string): string | undefined {
  const trimmed = cli.trim();
  if (!trimmed) return undefined;
  return trimmed.includes(':') ? trimmed.split(':')[0] : trimmed;
}

function validateStringArray(value: readonly string[] | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}

function cloneHarnessDefinition(config: HarnessDefinition): HarnessDefinition {
  return {
    ...config,
    ...(config.binaries ? { binaries: [...config.binaries] } : {}),
    ...(config.interactiveArgs ? { interactiveArgs: [...config.interactiveArgs] } : {}),
    ...(config.nonInteractiveArgs ? { nonInteractiveArgs: [...config.nonInteractiveArgs] } : {}),
    ...(config.modelArgs ? { modelArgs: [...config.modelArgs] } : {}),
    ...(config.bypassAliases ? { bypassAliases: [...config.bypassAliases] } : {}),
    ...(config.searchPaths ? { searchPaths: [...config.searchPaths] } : {}),
    ...(config.aliases ? { aliases: [...config.aliases] } : {}),
  };
}

function harnessConfigFromCliDefinition(definition: CliDefinition): HarnessDefinition {
  return {
    binaries: [...definition.binaries],
    ...(definition.bypassFlag ? { bypassFlag: definition.bypassFlag } : {}),
    ...(definition.bypassAliases ? { bypassAliases: [...definition.bypassAliases] } : {}),
    ...(definition.searchPaths ? { searchPaths: [...definition.searchPaths] } : {}),
    ...(definition.ignoreExitCode !== undefined ? { ignoreExitCode: definition.ignoreExitCode } : {}),
    ...(definition.proxyProvider ? { proxyProvider: definition.proxyProvider } : {}),
  };
}

function expandTemplateArg(
  template: string,
  context: { task: string; extraArgs: string[]; model?: string }
): string[] {
  if (template === '{args}' || template === '{{args}}') {
    return [...context.extraArgs];
  }
  if ((template === '{model}' || template === '{{model}}') && context.model === undefined) {
    return [];
  }
  return [
    template
      .replace(/\{\{\s*task\s*\}\}|\{task\}/g, context.task)
      .replace(/\{\{\s*model\s*\}\}|\{model\}/g, context.model ?? ''),
  ];
}

function renderArgTemplate(
  template: readonly string[],
  context: { task: string; extraArgs?: string[]; model?: string }
): string[] {
  const args: string[] = [];
  for (const entry of template) {
    args.push(
      ...expandTemplateArg(entry, {
        task: context.task,
        extraArgs: context.extraArgs ?? [],
        model: context.model,
      })
    );
  }
  return args;
}

function adapterFromConfig(name: string, config: HarnessDefinition): CliDefinition {
  const binaries =
    validateStringArray(config.binaries, `harness "${name}".binaries`) ??
    (config.binary ? [config.binary] : [name]);
  if (binaries.length === 0 || binaries.some((binary) => !binary.trim())) {
    throw new Error(`harness "${name}".binaries must contain at least one non-empty binary`);
  }

  const nonInteractiveTemplate =
    validateStringArray(config.nonInteractiveArgs, `harness "${name}".nonInteractiveArgs`) ??
    [...DEFAULT_NON_INTERACTIVE_TEMPLATE];
  const modelTemplate =
    validateStringArray(config.modelArgs, `harness "${name}".modelArgs`) ??
    [...DEFAULT_MODEL_ARGS_TEMPLATE];

  return {
    binaries,
    nonInteractiveArgs: (task, extraArgs = []) =>
      renderArgTemplate(nonInteractiveTemplate, { task, extraArgs }),
    modelArgs: (model) => renderArgTemplate(modelTemplate, { task: '', model }),
    bypassFlag: config.bypassFlag,
    bypassAliases: validateStringArray(config.bypassAliases, `harness "${name}".bypassAliases`),
    searchPaths: validateStringArray(config.searchPaths, `harness "${name}".searchPaths`),
    ignoreExitCode: config.ignoreExitCode,
    proxyProvider: config.proxyProvider,
  };
}

export type HarnessAdapter = CliDefinition | HarnessDefinition;

function isCliDefinition(adapter: HarnessAdapter): adapter is CliDefinition {
  return typeof (adapter as { nonInteractiveArgs?: unknown }).nonInteractiveArgs === 'function';
}

export function defineHarnessAdapter(name: string, adapter: HarnessAdapter): CliDefinition {
  if (isCliDefinition(adapter)) {
    return {
      ...adapter,
      binaries: [...adapter.binaries],
      bypassAliases: adapter.bypassAliases ? [...adapter.bypassAliases] : undefined,
      searchPaths: adapter.searchPaths ? [...adapter.searchPaths] : undefined,
    };
  }
  return adapterFromConfig(name, adapter as HarnessDefinition);
}

/**
 * Register or override a harness adapter at runtime.
 *
 * This is the SDK escape hatch for harnesses that are not built into Relay.
 * Programmatic adapters can provide functions; YAML/workflow configs should
 * use the serializable {@link HarnessDefinition} shape.
 */
export function registerHarnessAdapter(name: string, adapter: HarnessAdapter): void {
  const key = normalizeCliKey(name);
  const definition = defineHarnessAdapter(key, adapter);
  USER_CLI_REGISTRY.set(key, definition);
  const serializableConfig = isCliDefinition(adapter)
    ? harnessConfigFromCliDefinition(definition)
    : cloneHarnessDefinition(adapter);
  USER_HARNESS_CONFIGS.set(key, serializableConfig);

  const aliases = 'aliases' in adapter ? adapter.aliases : undefined;
  if (aliases) {
    for (const alias of aliases) {
      const aliasKey = normalizeCliKey(alias);
      USER_CLI_REGISTRY.set(aliasKey, definition);
      USER_HARNESS_CONFIGS.set(aliasKey, cloneHarnessDefinition(serializableConfig));
    }
  }
}

/** Backward-compatible name for callers that think in CLI definitions. */
export const registerCliDefinition = registerHarnessAdapter;

export function registerHarnessAdapters(adapters: Record<string, HarnessAdapter> | undefined): void {
  if (!adapters) return;
  for (const [name, adapter] of Object.entries(adapters)) {
    registerHarnessAdapter(name, adapter);
  }
}

/**
 * Get the CLI definition for a given CLI identifier.
 * Handles `cli:model` variants (e.g. `claude:opus`) by extracting the base CLI.
 */
export function getCliDefinition(cli: string): CliDefinition | undefined {
  const baseCli = lookupCliKey(cli);
  if (!baseCli) return undefined;
  return USER_CLI_REGISTRY.get(baseCli) ?? CLI_REGISTRY[baseCli as KnownAgentCli];
}

export const getHarnessAdapter = getCliDefinition;

export function getHarnessDefinition(cli: string): HarnessDefinition | undefined {
  const baseCli = lookupCliKey(cli);
  if (!baseCli) return undefined;
  const config = USER_HARNESS_CONFIGS.get(baseCli);
  return config ? cloneHarnessDefinition(config) : undefined;
}

export function buildModelArgs(cli: string, model: string | undefined): string[] {
  if (!model) return [];
  return getCliDefinition(cli)?.modelArgs?.(model) ?? ['--model', model];
}

/**
 * Get the full registry (read-only).
 */
export function getCliRegistry(): Readonly<Record<KnownAgentCli, CliDefinition>> {
  return CLI_REGISTRY;
}
