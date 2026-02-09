/**
 * Model Command Registry
 *
 * Maps CLI types to their mid-session model-switch commands.
 * Used by the spawner to send model switch commands to running agents.
 */

/**
 * Model command configuration for a specific CLI type.
 */
export interface ModelCommandConfig {
  /** Whether this CLI supports mid-session model switching */
  supported: boolean;
  /** Function to generate the command string for switching to a given model */
  buildCommand?: (model: string) => string;
  /** Valid model names for this CLI */
  validModels?: string[];
  /** Normalize a model name to the CLI's expected format */
  normalizeModel?: (model: string) => string;
}

/** Model name aliases for Claude Code */
const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  'claude-opus-4': 'opus',
  'claude-opus-4.5': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-sonnet-4': 'sonnet',
  'claude-sonnet-4-5': 'sonnet',
  'claude-haiku-3.5': 'haiku',
  'claude-haiku-4.5': 'haiku',
};

const CLAUDE_VALID_MODELS = ['opus', 'sonnet', 'haiku'];

/**
 * Registry of CLI model switch commands.
 * Claude-first; other CLIs can be added as they gain support.
 */
const CLI_MODEL_COMMANDS: Record<string, ModelCommandConfig> = {
  claude: {
    supported: true,
    buildCommand: (model: string) => `/model ${model}\n`,
    validModels: [
      ...CLAUDE_VALID_MODELS,
      ...Object.keys(CLAUDE_MODEL_ALIASES),
    ],
    normalizeModel: (model: string) => {
      const normalized = model.trim().toLowerCase();
      return CLAUDE_MODEL_ALIASES[normalized] ?? normalized;
    },
  },
  codex: { supported: false },
  gemini: { supported: false },
  droid: { supported: false },
  opencode: { supported: false },
  aider: { supported: false },
  goose: { supported: false },
  cursor: { supported: false },
};

/**
 * Get the model command configuration for a CLI type.
 */
export function getModelCommandConfig(cli: string): ModelCommandConfig {
  const baseCli = cli.split(':')[0].toLowerCase();
  return CLI_MODEL_COMMANDS[baseCli] ?? { supported: false };
}

/**
 * Check if a CLI type supports mid-session model switching.
 */
export function isModelSwitchSupported(cli: string): boolean {
  return getModelCommandConfig(cli).supported;
}

/**
 * Build the command string to switch models for a given CLI.
 * Returns null if the CLI doesn't support model switching.
 */
export function buildModelSwitchCommand(cli: string, model: string): string | null {
  const config = getModelCommandConfig(cli);
  if (!config.supported || !config.buildCommand) {
    return null;
  }

  const normalizedModel = config.normalizeModel ? config.normalizeModel(model) : model;
  return config.buildCommand(normalizedModel);
}

/**
 * Validate a model name for a given CLI.
 * Returns the normalized model name if valid.
 */
export function validateModelForCli(
  cli: string,
  model: string,
): { valid: boolean; error?: string; normalizedModel?: string } {
  const config = getModelCommandConfig(cli);

  if (!config.supported) {
    return {
      valid: false,
      error: `CLI "${cli}" does not support mid-session model switching`,
    };
  }

  const normalizedModel = config.normalizeModel ? config.normalizeModel(model) : model;

  if (config.validModels && !config.validModels.includes(normalizedModel)) {
    const displayModels = config.validModels.filter(m => !m.includes('-')); // Show short names only
    return {
      valid: false,
      error: `Invalid model "${model}" for CLI "${cli}". Valid models: ${displayModels.join(', ')}`,
    };
  }

  return { valid: true, normalizedModel };
}
