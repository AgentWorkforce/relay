export type SpawnOptionsTableVariant = 'relay-startup' | 'common' | 'advanced';
export type SpawnOptionsLanguage = 'typescript' | 'python';
type SpawnOptionDescription = string | Partial<Record<SpawnOptionsLanguage, string>>;

export type SpawnOptionRow = {
  typescript?: string[];
  python?: string[];
  description: SpawnOptionDescription;
};

const RELAY_STARTUP_ROWS: SpawnOptionRow[] = [
  {
    typescript: ['binaryPath'],
    python: ['binary_path'],
    description: 'Path to the agent-relay-broker binary. Auto-resolved if omitted.',
  },
  {
    typescript: ['binaryArgs'],
    python: ['binary_args'],
    description: {
      typescript: 'Extra args passed to `broker init` (for example `{ persist: true }`).',
      python: 'Extra args passed to `broker init` (for example `["--persist"]`).',
    },
  },
  {
    typescript: ['brokerName'],
    python: ['broker_name'],
    description: 'Broker name. Defaults to the current working directory basename.',
  },
  {
    typescript: ['channels'],
    python: ['channels'],
    description: 'Default channels for spawned agents.',
  },
  {
    typescript: ['cwd'],
    python: ['cwd'],
    description: 'Working directory for the broker process.',
  },
  {
    typescript: ['env'],
    python: ['env'],
    description: 'Environment variables for the broker process.',
  },
  {
    typescript: ['onStderr'],
    python: ['on_stderr'],
    description: 'Forward broker stderr lines to this callback.',
  },
  {
    typescript: ['startupTimeoutMs'],
    python: ['startup_timeout_ms'],
    description: 'Timeout in ms to wait for the broker to become ready. Defaults to `15000`.',
  },
  {
    typescript: ['requestTimeoutMs'],
    python: ['request_timeout_ms'],
    description: 'Timeout in ms for HTTP requests to the broker. Defaults to `30000`.',
  },
];

const COMMON_ROWS: SpawnOptionRow[] = [
  { typescript: ['name'], python: ['name'], description: 'Stable identity other agents can message' },
  { typescript: ['model'], python: ['model'], description: 'Model string or enum for that provider' },
  { typescript: ['task'], python: ['task'], description: 'Initial prompt for autonomous startup' },
  { typescript: ['channels'], python: ['channels'], description: 'Rooms the agent joins on spawn' },
  { typescript: ['args'], python: ['args'], description: 'Extra CLI arguments' },
  { typescript: ['cwd'], python: ['cwd'], description: 'Per-agent working directory override' },
  {
    typescript: ['skipRelayPrompt'],
    python: ['skip_relay_prompt'],
    description: 'Skip MCP/protocol prompt injection when relay messaging is not needed',
  },
  {
    typescript: ['onStart'],
    python: ['on_start'],
    description: 'Run code before spawn',
  },
  {
    typescript: ['onSuccess'],
    python: ['on_success'],
    description: 'Run code after a successful spawn',
  },
  {
    typescript: ['onError'],
    python: ['on_error'],
    description: 'Run code if spawn fails',
  },
];

const ADVANCED_ROWS: SpawnOptionRow[] = [
  {
    typescript: ['team'],
    python: ['team'],
    description: 'Attach the agent to a team-aware workflow or relay-managed grouping',
  },
  {
    typescript: ['shadowOf'],
    python: ['shadow_of'],
    description: 'Spawn a shadow worker linked to another agent',
  },
  {
    typescript: ['shadowMode'],
    python: ['shadow_mode'],
    description: 'Configure shadow behavior',
  },
  {
    typescript: ['idleThresholdSecs'],
    python: ['idle_threshold_secs'],
    description: 'Control when idle lifecycle events fire',
  },
  {
    typescript: ['restartPolicy'],
    python: ['restart_policy'],
    description: 'Configure broker-managed restart behavior',
  },
];

export function getSpawnOptionRows(variant: SpawnOptionsTableVariant): SpawnOptionRow[] {
  if (variant === 'relay-startup') {
    return RELAY_STARTUP_ROWS;
  }

  return variant === 'advanced' ? ADVANCED_ROWS : COMMON_ROWS;
}

export function getSpawnOptionName(
  row: SpawnOptionRow,
  language: SpawnOptionsLanguage
): string[] {
  return (language === 'python' ? row.python : row.typescript) ?? [];
}

export function getSpawnOptionDescription(
  row: SpawnOptionRow,
  language: SpawnOptionsLanguage
): string {
  if (typeof row.description === 'string') {
    return row.description;
  }

  return row.description[language] ?? row.description.typescript ?? row.description.python ?? '';
}
