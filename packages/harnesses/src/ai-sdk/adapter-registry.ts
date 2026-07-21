import type { HarnessV1 } from '@ai-sdk/harness';

export type AiSdkAdapterRollout = 'experimental' | 'validated' | 'default';

export interface AiSdkLifecycleCapabilities {
  activeInput: boolean;
  toolApprovals: boolean;
  compact: boolean;
  continueTurn: boolean;
  suspendTurn: boolean;
  detach: boolean;
  stop: boolean;
  destroy: boolean;
  stopPreservesConversation: boolean;
}

export interface RelayAdapterSettings {
  model?: string;
  auth?: unknown;
  port?: number;
  startupTimeoutMs?: number;
  maxTurns?: number;
  thinking?: unknown;
  thinkingLevel?: unknown;
  reasoningEffort?: 'low' | 'medium' | 'high';
  reasoningVariant?: string;
  provider?: string;
  webSearch?: boolean;
  recursionLimit?: number;
}

export interface AiSdkAdapterRegistryEntry {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly packageName: string;
  readonly execution: 'bridge' | 'host';
  readonly lifecycle: AiSdkLifecycleCapabilities;
  readonly ptyAvailable: boolean;
  readonly rollout: AiSdkAdapterRollout;
  readonly mapSettings: (settings: RelayAdapterSettings) => Record<string, unknown>;
  readonly createHarness: (settings?: RelayAdapterSettings) => Promise<HarnessV1>;
}

type HarnessFactory = (settings?: Record<string, unknown>) => HarnessV1;

function pickSettings(
  settings: RelayAdapterSettings,
  keys: readonly (keyof RelayAdapterSettings)[]
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const key of keys) {
    const value = settings[key];
    if (value !== undefined) mapped[key] = value;
  }
  return mapped;
}

function lazyFactory(
  packageName: string,
  load: () => Promise<Record<string, unknown>>,
  exportName: string,
  mapSettings: AiSdkAdapterRegistryEntry['mapSettings']
): AiSdkAdapterRegistryEntry['createHarness'] {
  return async (settings) => {
    let loaded: Record<string, unknown>;
    try {
      loaded = await load();
    } catch (error) {
      throw new Error(`AI SDK harness adapter ${packageName} is unavailable`, { cause: error });
    }
    const factory = loaded[exportName];
    if (typeof factory !== 'function') {
      throw new Error(`AI SDK harness adapter ${packageName} does not export ${exportName}`);
    }
    return (factory as HarnessFactory)(mapSettings(settings ?? {}));
  };
}

const FULL_LIFECYCLE: AiSdkLifecycleCapabilities = {
  activeInput: true,
  toolApprovals: true,
  compact: true,
  continueTurn: true,
  suspendTurn: true,
  detach: true,
  stop: true,
  destroy: true,
  stopPreservesConversation: true,
};

// The upstream adapter currently defaults to gpt-5.3-codex, which ChatGPT-account
// authentication no longer accepts. Keep Relay's default aligned with Codex CLI
// while still allowing callers to select another supported model explicitly.
const DEFAULT_CODEX_MODEL = 'gpt-5.6-terra';

const codexSettings = (settings: RelayAdapterSettings) => ({
  model: settings.model ?? DEFAULT_CODEX_MODEL,
  ...pickSettings(settings, ['auth', 'port', 'startupTimeoutMs', 'reasoningEffort', 'webSearch']),
});

const openCodeSettings = (settings: RelayAdapterSettings) =>
  pickSettings(settings, ['model', 'auth', 'port', 'startupTimeoutMs', 'provider', 'reasoningVariant']);

const claudeSettings = (settings: RelayAdapterSettings) =>
  pickSettings(settings, ['model', 'auth', 'port', 'startupTimeoutMs', 'maxTurns', 'thinking']);

const piSettings = (settings: RelayAdapterSettings) =>
  pickSettings(settings, ['model', 'auth', 'thinkingLevel']);

const deepAgentsSettings = (settings: RelayAdapterSettings) =>
  pickSettings(settings, ['model', 'auth', 'port', 'startupTimeoutMs', 'recursionLimit']);

const ENTRIES: readonly AiSdkAdapterRegistryEntry[] = [
  {
    name: 'claude',
    aliases: ['claude-code'],
    packageName: '@ai-sdk/harness-claude-code',
    execution: 'bridge',
    lifecycle: FULL_LIFECYCLE,
    ptyAvailable: true,
    rollout: 'experimental',
    mapSettings: claudeSettings,
    createHarness: lazyFactory(
      '@ai-sdk/harness-claude-code',
      () => import('@ai-sdk/harness-claude-code'),
      'createClaudeCode',
      claudeSettings
    ),
  },
  {
    name: 'codex',
    aliases: [],
    packageName: '@ai-sdk/harness-codex',
    execution: 'bridge',
    lifecycle: FULL_LIFECYCLE,
    ptyAvailable: true,
    rollout: 'experimental',
    mapSettings: codexSettings,
    createHarness: lazyFactory(
      '@ai-sdk/harness-codex',
      () => import('@ai-sdk/harness-codex'),
      'createCodex',
      codexSettings
    ),
  },
  {
    name: 'opencode',
    aliases: ['open-code'],
    packageName: '@ai-sdk/harness-opencode',
    execution: 'bridge',
    lifecycle: FULL_LIFECYCLE,
    ptyAvailable: true,
    rollout: 'experimental',
    mapSettings: openCodeSettings,
    createHarness: lazyFactory(
      '@ai-sdk/harness-opencode',
      () => import('@ai-sdk/harness-opencode'),
      'createOpenCode',
      openCodeSettings
    ),
  },
  {
    name: 'pi',
    aliases: [],
    packageName: '@ai-sdk/harness-pi',
    execution: 'host',
    lifecycle: FULL_LIFECYCLE,
    ptyAvailable: false,
    rollout: 'experimental',
    mapSettings: piSettings,
    createHarness: lazyFactory(
      '@ai-sdk/harness-pi',
      () => import('@ai-sdk/harness-pi'),
      'createPi',
      piSettings
    ),
  },
  {
    name: 'deepagents',
    aliases: ['deep-agents'],
    packageName: '@ai-sdk/harness-deepagents',
    execution: 'bridge',
    lifecycle: { ...FULL_LIFECYCLE, compact: false, stopPreservesConversation: false },
    ptyAvailable: false,
    rollout: 'experimental',
    mapSettings: deepAgentsSettings,
    createHarness: lazyFactory(
      '@ai-sdk/harness-deepagents',
      () => import('@ai-sdk/harness-deepagents'),
      'createDeepAgents',
      deepAgentsSettings
    ),
  },
];

export class AiSdkAdapterRegistry {
  readonly #byName = new Map<string, AiSdkAdapterRegistryEntry>();
  readonly #entries: readonly AiSdkAdapterRegistryEntry[];

  constructor(entries: readonly AiSdkAdapterRegistryEntry[] = ENTRIES) {
    this.#entries = [...entries];
    for (const entry of entries) {
      for (const candidate of [entry.name, ...entry.aliases]) {
        const key = candidate.toLowerCase();
        if (this.#byName.has(key)) throw new Error(`Duplicate AI SDK adapter alias: ${candidate}`);
        this.#byName.set(key, entry);
      }
    }
  }

  list(): readonly AiSdkAdapterRegistryEntry[] {
    return this.#entries;
  }

  get(name: string): AiSdkAdapterRegistryEntry | undefined {
    return this.#byName.get(name.toLowerCase());
  }

  require(name: string): AiSdkAdapterRegistryEntry {
    const entry = this.get(name);
    if (!entry) throw new Error(`No AI SDK harness adapter is registered for ${name}`);
    return entry;
  }
}

export const aiSdkAdapterRegistry = new AiSdkAdapterRegistry();
