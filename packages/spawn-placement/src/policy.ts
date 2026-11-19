/**
 * Memory policy settings: defaults and the one parser every control plane
 * uses, so the same setting strings mean the same thing everywhere.
 */

export type NodeKind = 'desktop' | 'broker' | 'hosted';

/**
 * - `off`: today's placement. Callers add no memory fields.
 * - `observe`: memory is assessed and reported; ranking and admission unchanged.
 * - `rank`: memory tier and admissibility change ranking and alternatives; nothing is refused.
 * - `enforce`: also refuses a launch that does not fit (`spawn_memory_low`).
 */
export type MemoryPolicyMode = 'off' | 'observe' | 'rank' | 'enforce';
export const MEMORY_POLICY_MODES: readonly MemoryPolicyMode[] = ['off', 'observe', 'rank', 'enforce'];

/** Memory kept free on a machine: the larger of an absolute amount and a fraction of total. */
export interface MemoryFloor {
  bytes: number;
  fraction: number;
}

export interface MemoryPolicy {
  mode: MemoryPolicyMode;
  floor: Readonly<Record<NodeKind, MemoryFloor>>;
  /** Launch headroom budget per harness id; `*` is the default and the figure used when no harness is named. */
  harnessNeedBytes: Readonly<Record<string, number>>;
  /** Steady-state budget per running agent, for the density cap. */
  agentSteadyBytes: number;
  /** Apply the density cap to nodes with a finite `maxAgents` too (always applied when `maxAgents` is 0). */
  densityCapsConfigured: boolean;
  /** A sample older than this is unknown. */
  freshSeconds: number;
  /** A sample this far in the future (node clock ahead) is still fresh. */
  futureSkewSeconds: number;
  /** Headroom after the launch for the `ample` tier. */
  ampleHeadroomBytes: number;
  /** Fraction of total still available after the launch for the `ample` tier. */
  ampleFraction: number;
  /** Hint returned with `spawn_memory_low` when no alternative fits. */
  retryAfterSeconds: number;
}

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = Object.freeze({
  mode: 'observe',
  floor: Object.freeze({
    desktop: Object.freeze({ bytes: 2 * GIB, fraction: 0.1 }),
    broker: Object.freeze({ bytes: 1 * GIB, fraction: 0.05 }),
    hosted: Object.freeze({ bytes: 1 * GIB, fraction: 0.05 }),
  }),
  harnessNeedBytes: Object.freeze({
    claude: 1.5 * GIB,
    codex: 1 * GIB,
    opencode: 1.5 * GIB,
    grok: 1 * GIB,
    '*': 1.5 * GIB,
  }),
  agentSteadyBytes: 1 * GIB,
  densityCapsConfigured: false,
  freshSeconds: 45,
  futureSkewSeconds: 30,
  ampleHeadroomBytes: 4 * GIB,
  ampleFraction: 0.25,
  retryAfterSeconds: 30,
}) as MemoryPolicy;

/** The raw setting strings, as environment variables or flags carry them. Absent means the default. */
export interface MemoryPolicySettings {
  /** `off|observe|rank|enforce` */
  mode?: string;
  /** `desktop=2GiB/10%,broker=1GiB/5%,hosted=1GiB/5%`; kinds left out keep their default. */
  floor?: string;
  /** `claude=1.5GiB,codex=1GiB,*=1.5GiB`; harnesses left out keep their default. */
  harnessMemory?: string;
  /** `1GiB` */
  agentMemory?: string;
  /** `true|false` */
  densityCapsConfigured?: string;
  /** Whole seconds, 1–3600. */
  freshSeconds?: string;
}

export class MemoryPolicyError extends Error {
  constructor(
    readonly setting: keyof MemoryPolicySettings,
    message: string
  ) {
    super(message);
    this.name = 'MemoryPolicyError';
  }
}

const UNITS: Record<string, number> = {
  b: 1,
  kib: KIB,
  mib: MIB,
  gib: GIB,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
};
const HARNESS = /^(?:\*|[a-z0-9][a-z0-9-]{0,31})$/;
const KINDS: readonly NodeKind[] = ['desktop', 'broker', 'hosted'];

/** `1.5GiB`, `512MiB`, `2GB` or a whole number of bytes. Rounds down to a whole byte. */
export function parseBytes(value: string): number | null {
  // Trim first and bound the length, so the pattern has no ambiguous whitespace to backtrack over.
  const text = value.trim();
  if (text.length === 0 || text.length > 32) return null;
  const match = /^(\d{1,20}(?:\.\d{1,20})?) ?([a-zA-Z]{0,3})$/.exec(text);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const scale = unit === '' ? 1 : Object.hasOwn(UNITS, unit) ? UNITS[unit] : undefined;
  if (scale === undefined || (unit === '' && match[1].includes('.'))) return null;
  const bytes = Math.floor(Number(match[1]) * scale);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function pairs(setting: keyof MemoryPolicySettings, value: string): Array<[string, string]> {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new MemoryPolicyError(setting, `${setting} is empty`);
  return entries.map((entry) => {
    const at = entry.indexOf('=');
    if (at <= 0) throw new MemoryPolicyError(setting, `${setting} entry "${entry}" is not key=value`);
    return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()];
  });
}

/**
 * Settings to a frozen policy. Throws `MemoryPolicyError` naming the setting
 * on any invalid value, so a control plane fails at startup, not at launch.
 */
export function parseMemoryPolicy(
  settings: MemoryPolicySettings = {},
  base: MemoryPolicy = DEFAULT_MEMORY_POLICY
): MemoryPolicy {
  let mode = base.mode;
  if (settings.mode !== undefined && settings.mode.trim() !== '') {
    const value = settings.mode.trim().toLowerCase();
    if (!(MEMORY_POLICY_MODES as readonly string[]).includes(value)) {
      throw new MemoryPolicyError('mode', `mode must be one of ${MEMORY_POLICY_MODES.join(', ')}`);
    }
    mode = value as MemoryPolicyMode;
  }

  const floor: Record<NodeKind, MemoryFloor> = { ...base.floor };
  if (settings.floor !== undefined && settings.floor.trim() !== '') {
    for (const [kind, value] of pairs('floor', settings.floor)) {
      if (!(KINDS as readonly string[]).includes(kind))
        throw new MemoryPolicyError('floor', `floor kind "${kind}" is not desktop, broker or hosted`);
      const match = /^([^/]+)\/(\d+(?:\.\d+)?)%$/.exec(value);
      const bytes = match ? parseBytes(match[1]) : null;
      const percent = match ? Number(match[2]) : NaN;
      if (bytes === null || !(percent >= 0 && percent < 100)) {
        throw new MemoryPolicyError('floor', `floor for ${kind} must look like 2GiB/10%`);
      }
      floor[kind as NodeKind] = Object.freeze({ bytes, fraction: percent / 100 });
    }
  }

  const harnessNeedBytes: Record<string, number> = { ...base.harnessNeedBytes };
  if (settings.harnessMemory !== undefined && settings.harnessMemory.trim() !== '') {
    for (const [harness, value] of pairs('harnessMemory', settings.harnessMemory)) {
      const bytes = parseBytes(value);
      if (!HARNESS.test(harness))
        throw new MemoryPolicyError('harnessMemory', `harness "${harness}" is not a harness id or *`);
      if (bytes === null || bytes <= 0)
        throw new MemoryPolicyError(
          'harnessMemory',
          `memory for ${harness} must be a positive size such as 1.5GiB`
        );
      harnessNeedBytes[harness] = bytes;
    }
  }

  let agentSteadyBytes = base.agentSteadyBytes;
  if (settings.agentMemory !== undefined && settings.agentMemory.trim() !== '') {
    const bytes = parseBytes(settings.agentMemory);
    if (bytes === null || bytes <= 0)
      throw new MemoryPolicyError('agentMemory', 'agentMemory must be a positive size such as 1GiB');
    agentSteadyBytes = bytes;
  }

  let densityCapsConfigured = base.densityCapsConfigured;
  if (settings.densityCapsConfigured !== undefined && settings.densityCapsConfigured.trim() !== '') {
    const value = settings.densityCapsConfigured.trim().toLowerCase();
    if (value !== 'true' && value !== 'false')
      throw new MemoryPolicyError('densityCapsConfigured', 'densityCapsConfigured must be true or false');
    densityCapsConfigured = value === 'true';
  }

  let freshSeconds = base.freshSeconds;
  if (settings.freshSeconds !== undefined && settings.freshSeconds.trim() !== '') {
    const value = settings.freshSeconds.trim();
    const seconds = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!(seconds >= 1 && seconds <= 3600))
      throw new MemoryPolicyError('freshSeconds', 'freshSeconds must be a whole number from 1 to 3600');
    freshSeconds = seconds;
  }

  return Object.freeze({
    ...base,
    mode,
    floor: Object.freeze(floor),
    harnessNeedBytes: Object.freeze(harnessNeedBytes),
    agentSteadyBytes,
    densityCapsConfigured,
    freshSeconds,
  });
}

/** The launch budget for this harness, or the default (`*`) when it has none or none is named. */
export function harnessNeed(policy: MemoryPolicy, harness: string | null | undefined): number {
  return (
    // Own keys only: a harness named like an Object.prototype member must not resolve to it.
    (harness && Object.hasOwn(policy.harnessNeedBytes, harness)
      ? policy.harnessNeedBytes[harness]
      : undefined) ??
    policy.harnessNeedBytes['*'] ??
    DEFAULT_MEMORY_POLICY.harnessNeedBytes['*']
  );
}
