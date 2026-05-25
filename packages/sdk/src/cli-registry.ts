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

export const BUILTIN_HARNESS_DEFINITIONS: Readonly<Partial<Record<KnownAgentCli, HarnessDefinition>>> = {
  claude: {
    adapter: 'claude',
    binary: 'claude',
    nonInteractiveArgs: ['-p', '{bypass}', '{task}', '{args}'],
    bypassFlag: '--dangerously-skip-permissions',
    searchPaths: ['~/.claude/local'],
  },
  codex: {
    adapter: 'codex',
    binary: 'codex',
    nonInteractiveArgs: ['exec', '{bypass}', '{task}', '{args}'],
    bypassFlag: '--dangerously-bypass-approvals-and-sandbox',
    bypassAliases: ['--full-auto'],
    searchPaths: ['~/.local/bin'],
  },
  gemini: {
    adapter: 'gemini',
    binary: 'gemini',
    nonInteractiveArgs: ['-p', '{task}', '{args}'],
    bypassFlag: '--yolo',
    bypassAliases: ['-y'],
  },
  opencode: {
    adapter: 'opencode',
    binary: 'opencode',
    nonInteractiveArgs: ['run', '{task}', '{args}'],
    searchPaths: ['~/.opencode/bin'],
    ignoreExitCode: true,
  },
  droid: {
    adapter: 'droid',
    binary: 'droid',
    nonInteractiveArgs: ['exec', '{task}', '{args}'],
  },
  aider: {
    adapter: 'aider',
    binary: 'aider',
    nonInteractiveArgs: ['--message', '{task}', '--yes-always', '--no-git', '{args}'],
  },
  goose: {
    adapter: 'goose',
    binary: 'goose',
    nonInteractiveArgs: ['run', '--text', '{task}', '--no-session', '{args}'],
  },
  'cursor-agent': {
    adapter: 'cursor',
    binary: 'cursor-agent',
    nonInteractiveArgs: ['--force', '-p', '{task}', '{args}'],
  },
  agent: {
    adapter: 'cursor',
    binary: 'agent',
    nonInteractiveArgs: ['--force', '-p', '{task}', '{args}'],
  },
  cursor: {
    adapter: 'cursor',
    binaries: ['cursor-agent', 'agent'],
    nonInteractiveArgs: ['--force', '-p', '{task}', '{args}'],
  },
};

const CLI_REGISTRY: Record<KnownAgentCli, CliDefinition> = {
  claude: adapterFromConfig('claude', BUILTIN_HARNESS_DEFINITIONS.claude!),
  codex: adapterFromConfig('codex', BUILTIN_HARNESS_DEFINITIONS.codex!),
  gemini: adapterFromConfig('gemini', BUILTIN_HARNESS_DEFINITIONS.gemini!),
  opencode: adapterFromConfig('opencode', BUILTIN_HARNESS_DEFINITIONS.opencode!),
  droid: adapterFromConfig('droid', BUILTIN_HARNESS_DEFINITIONS.droid!),
  aider: adapterFromConfig('aider', BUILTIN_HARNESS_DEFINITIONS.aider!),
  goose: adapterFromConfig('goose', BUILTIN_HARNESS_DEFINITIONS.goose!),
  'cursor-agent': adapterFromConfig('cursor-agent', BUILTIN_HARNESS_DEFINITIONS['cursor-agent']!),
  agent: adapterFromConfig('agent', BUILTIN_HARNESS_DEFINITIONS.agent!),
  cursor: adapterFromConfig('cursor', BUILTIN_HARNESS_DEFINITIONS.cursor!),
  api: {
    binaries: [],
    nonInteractiveArgs: (task) => [task],
  },
};

const USER_CLI_REGISTRY = new Map<string, CliDefinition>();
const USER_HARNESS_CONFIGS = new Map<string, HarnessDefinition>();

function normalizedBaseCliKey(cli: string): string | undefined {
  const trimmed = cli.trim();
  if (!trimmed) return undefined;
  const base = (trimmed.includes(':') ? trimmed.split(':')[0] : trimmed).trim();
  return base || undefined;
}

function normalizeCliKey(cli: string): string {
  const base = normalizedBaseCliKey(cli);
  if (!base) {
    throw new Error('Harness name must be a non-empty string');
  }
  return base;
}

function lookupCliKey(cli: string): string | undefined {
  return normalizedBaseCliKey(cli);
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
    ...(config.adapter ? { adapter: config.adapter } : {}),
    ...(config.binaries ? { binaries: [...config.binaries] } : {}),
    ...(config.interactiveArgs ? { interactiveArgs: [...config.interactiveArgs] } : {}),
    ...(config.nonInteractiveArgs ? { nonInteractiveArgs: [...config.nonInteractiveArgs] } : {}),
    ...(config.modelArgs ? { modelArgs: [...config.modelArgs] } : {}),
    ...(config.bypassAliases ? { bypassAliases: [...config.bypassAliases] } : {}),
    ...(config.searchPaths ? { searchPaths: [...config.searchPaths] } : {}),
    ...(config.aliases ? { aliases: [...config.aliases] } : {}),
  };
}

function mergeHarnessDefinitions(base: HarnessDefinition, override: HarnessDefinition): HarnessDefinition {
  const overrideBinary = override.binary?.trim() ? override.binary : undefined;
  return {
    ...cloneHarnessDefinition(base),
    ...cloneHarnessDefinition(override),
    adapter: override.adapter ?? base.adapter,
    binary: overrideBinary ?? base.binary,
    ...(override.binaries
      ? { binaries: [...override.binaries] }
      : overrideBinary !== undefined
        ? { binaries: undefined }
        : base.binaries
          ? { binaries: [...base.binaries] }
          : {}),
    ...(override.interactiveArgs
      ? { interactiveArgs: [...override.interactiveArgs] }
      : base.interactiveArgs
        ? { interactiveArgs: [...base.interactiveArgs] }
        : {}),
    ...(override.nonInteractiveArgs
      ? { nonInteractiveArgs: [...override.nonInteractiveArgs] }
      : base.nonInteractiveArgs
        ? { nonInteractiveArgs: [...base.nonInteractiveArgs] }
        : {}),
    ...(override.modelArgs
      ? { modelArgs: [...override.modelArgs] }
      : base.modelArgs
        ? { modelArgs: [...base.modelArgs] }
        : {}),
    bypassFlag: override.bypassFlag ?? base.bypassFlag,
    ...(override.bypassAliases
      ? { bypassAliases: [...override.bypassAliases] }
      : base.bypassAliases
        ? { bypassAliases: [...base.bypassAliases] }
        : {}),
    ...(override.searchPaths
      ? { searchPaths: [...override.searchPaths] }
      : base.searchPaths
        ? { searchPaths: [...base.searchPaths] }
        : {}),
    ignoreExitCode: override.ignoreExitCode ?? base.ignoreExitCode,
    proxyProvider: override.proxyProvider ?? base.proxyProvider,
    ...(override.aliases
      ? { aliases: [...override.aliases] }
      : base.aliases
        ? { aliases: [...base.aliases] }
        : {}),
  };
}

function resolveHarnessConfig(name: string, config: HarnessDefinition): HarnessDefinition {
  const adapterKey = lookupCliKey(config.adapter ?? name);
  const base = adapterKey ? BUILTIN_HARNESS_DEFINITIONS[adapterKey as KnownAgentCli] : undefined;
  return base ? mergeHarnessDefinitions(base, config) : cloneHarnessDefinition(config);
}

export function defineHarnessDefinition(name: string, definition: HarnessDefinition): HarnessDefinition {
  return resolveHarnessConfig(normalizeCliKey(name), definition);
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

function argMatchesFlag(arg: string, flag: string): boolean {
  return arg === flag || arg.startsWith(`${flag}=`);
}

function resolveTemplateBypass(config: HarnessDefinition, extraArgs: string[]): string | undefined {
  const flag = config.bypassFlag?.trim();
  if (!flag) return undefined;

  const candidates = [flag, ...(config.bypassAliases ?? []).map((alias) => alias.trim()).filter(Boolean)];
  return extraArgs.some((arg) => candidates.some((candidate) => argMatchesFlag(arg, candidate)))
    ? undefined
    : flag;
}

function expandTemplateArg(
  template: string,
  context: { task: string; extraArgs: string[]; bypass?: string; model?: string }
): string[] {
  if (template === '{args}' || template === '{{args}}') {
    return [...context.extraArgs];
  }
  if (template === '{bypass}' || template === '{{bypass}}') {
    return context.bypass ? [context.bypass] : [];
  }
  if ((template === '{model}' || template === '{{model}}') && context.model === undefined) {
    return [];
  }
  return [
    template
      .replace(/\{\{\s*task\s*\}\}|\{task\}/g, context.task)
      .replace(/\{\{\s*bypass\s*\}\}|\{bypass\}/g, context.bypass ?? '')
      .replace(/\{\{\s*model\s*\}\}|\{model\}/g, context.model ?? ''),
  ];
}

function renderArgTemplate(
  template: readonly string[],
  context: { task: string; extraArgs?: string[]; bypass?: string; model?: string }
): string[] {
  const args: string[] = [];
  for (const entry of template) {
    args.push(
      ...expandTemplateArg(entry, {
        task: context.task,
        extraArgs: context.extraArgs ?? [],
        bypass: context.bypass,
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

  const nonInteractiveTemplate = validateStringArray(
    config.nonInteractiveArgs,
    `harness "${name}".nonInteractiveArgs`
  ) ?? [...DEFAULT_NON_INTERACTIVE_TEMPLATE];
  const modelTemplate = validateStringArray(config.modelArgs, `harness "${name}".modelArgs`) ?? [
    ...DEFAULT_MODEL_ARGS_TEMPLATE,
  ];

  return {
    binaries,
    nonInteractiveArgs: (task, extraArgs = []) =>
      renderArgTemplate(nonInteractiveTemplate, {
        task,
        extraArgs,
        bypass: resolveTemplateBypass(config, extraArgs),
      }),
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
  return adapterFromConfig(name, resolveHarnessConfig(name, adapter as HarnessDefinition));
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
    : resolveHarnessConfig(key, adapter);
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

export interface HarnessRegistrySnapshot {
  cliRegistry: Map<string, CliDefinition>;
  harnessConfigs: Map<string, HarnessDefinition>;
}

function cloneCliDefinition(definition: CliDefinition): CliDefinition {
  return {
    ...definition,
    binaries: [...definition.binaries],
    bypassAliases: definition.bypassAliases ? [...definition.bypassAliases] : undefined,
    searchPaths: definition.searchPaths ? [...definition.searchPaths] : undefined,
  };
}

export function snapshotHarnessAdapters(): HarnessRegistrySnapshot {
  return {
    cliRegistry: new Map(
      [...USER_CLI_REGISTRY].map(([key, definition]) => [key, cloneCliDefinition(definition)])
    ),
    harnessConfigs: new Map(
      [...USER_HARNESS_CONFIGS].map(([key, config]) => [key, cloneHarnessDefinition(config)])
    ),
  };
}

export function restoreHarnessAdapters(snapshot: HarnessRegistrySnapshot): void {
  USER_CLI_REGISTRY.clear();
  USER_HARNESS_CONFIGS.clear();
  for (const [key, definition] of snapshot.cliRegistry) {
    USER_CLI_REGISTRY.set(key, cloneCliDefinition(definition));
  }
  for (const [key, config] of snapshot.harnessConfigs) {
    USER_HARNESS_CONFIGS.set(key, cloneHarnessDefinition(config));
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

export function getBuiltInHarnessDefinitions(): Readonly<Partial<Record<KnownAgentCli, HarnessDefinition>>> {
  return BUILTIN_HARNESS_DEFINITIONS;
}

export function getHarnessDefinition(cli: string): HarnessDefinition | undefined {
  const baseCli = lookupCliKey(cli);
  if (!baseCli) return undefined;
  const config = USER_HARNESS_CONFIGS.get(baseCli);
  if (config) return cloneHarnessDefinition(config);
  const builtIn = BUILTIN_HARNESS_DEFINITIONS[baseCli as KnownAgentCli];
  return builtIn ? cloneHarnessDefinition(builtIn) : undefined;
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
