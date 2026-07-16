import {
  createAgentObservabilityCapabilities,
  EXACT_AND_INFERRED_OBSERVABILITY,
  EXACT_OBSERVABILITY,
  INFERRED_OBSERVABILITY,
  type AgentActivity,
  type AgentEvent,
  type AgentObservabilityCapabilities,
  type AgentSessionEvent,
} from '@agent-relay/sdk';

export const AI_SDK_REFERENCE_OBSERVABILITY_PROFILE: AgentObservabilityCapabilities =
  createAgentObservabilityCapabilities({
    activities: {
      starting: EXACT_OBSERVABILITY,
      thinking: EXACT_AND_INFERRED_OBSERVABILITY,
      typing: EXACT_OBSERVABILITY,
      using_tool: EXACT_OBSERVABILITY,
      waiting: EXACT_OBSERVABILITY,
      idle: EXACT_OBSERVABILITY,
      error: EXACT_OBSERVABILITY,
    },
    events: {
      lifecycle: EXACT_OBSERVABILITY,
      turns: EXACT_OBSERVABILITY,
      text: EXACT_OBSERVABILITY,
      reasoning: EXACT_OBSERVABILITY,
      tools: EXACT_OBSERVABILITY,
      tool_approvals: EXACT_OBSERVABILITY,
      files: EXACT_OBSERVABILITY,
      compaction: EXACT_OBSERVABILITY,
      model: EXACT_OBSERVABILITY,
      warnings: EXACT_OBSERVABILITY,
      usage: EXACT_OBSERVABILITY,
      diagnostics: EXACT_OBSERVABILITY,
      errors: EXACT_OBSERVABILITY,
    },
  });

const PTY_HARNESSES = [
  'claude',
  'codex',
  'gemini',
  'cursor-agent',
  'droid',
  'opencode',
  'aider',
  'goose',
  'grok',
] as const;

export type PtyHarnessName = (typeof PTY_HARNESSES)[number];

/**
 * PTY observability is deliberately conservative. The broker owns exact
 * process lifecycle signals and can infer a busy/idle turn boundary, but raw
 * terminal bytes are not treated as structured assistant, reasoning, or tool
 * events.
 */
export const PTY_OBSERVABILITY_PROFILE: AgentObservabilityCapabilities = createAgentObservabilityCapabilities(
  {
    activities: {
      starting: EXACT_OBSERVABILITY,
      thinking: INFERRED_OBSERVABILITY,
      idle: INFERRED_OBSERVABILITY,
      error: EXACT_OBSERVABILITY,
    },
    events: {
      lifecycle: EXACT_OBSERVABILITY,
      turns: INFERRED_OBSERVABILITY,
      errors: EXACT_OBSERVABILITY,
    },
  }
);

export const PTY_OBSERVABILITY_PROFILES = Object.fromEntries(
  PTY_HARNESSES.map((name) => [name, PTY_OBSERVABILITY_PROFILE])
) as Record<PtyHarnessName, AgentObservabilityCapabilities>;

const PTY_ALIASES: Record<string, PtyHarnessName> = {
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'cursor-agent',
  'cursor-agent': 'cursor-agent',
  droid: 'droid',
  opencode: 'opencode',
  aider: 'aider',
  goose: 'goose',
  grok: 'grok',
};

export function getPtyObservabilityProfile(harnessName: string): AgentObservabilityCapabilities {
  const canonicalName = PTY_ALIASES[harnessName.toLowerCase()];
  if (!canonicalName) {
    throw new Error(`No PTY observability profile is registered for ${harnessName}`);
  }
  return PTY_OBSERVABILITY_PROFILES[canonicalName];
}

export type PtyObservabilitySignal =
  | { type: 'starting'; at?: Date | string }
  | { type: 'busy'; turnId: string; at?: Date | string }
  | { type: 'idle'; turnId: string; at?: Date | string }
  | { type: 'error'; error: string; code?: string; at?: Date | string };

export type PtyAgentEvent = AgentEvent | Extract<AgentSessionEvent, { type: 'activity.changed' }>;

export interface PtyObservabilityTranslator {
  readonly capabilities: AgentObservabilityCapabilities;
  translate(signal: PtyObservabilitySignal): PtyAgentEvent[];
}

/** Translate broker-owned PTY lifecycle evidence into the canonical contract. */
export function createPtyObservabilityTranslator(harnessName: string): PtyObservabilityTranslator {
  const capabilities = getPtyObservabilityProfile(harnessName);
  let sequence = 0;
  let activity: AgentActivity = 'idle';
  let activeTurnId: string | undefined;

  const observation = (fidelity: 'exact' | 'inferred', at: Date | string, turnId?: string) => ({
    source: 'broker' as const,
    fidelity,
    sequence: ++sequence,
    timestamp: at,
    ...(turnId ? { turnId } : {}),
  });

  const transition = (
    next: AgentActivity,
    reason: string,
    fidelity: 'exact' | 'inferred',
    at: Date | string,
    turnId?: string
  ): PtyAgentEvent | undefined => {
    if (activity === next) return undefined;
    const previousActivity = activity;
    activity = next;
    return {
      type: 'activity.changed',
      activity: next,
      previousActivity,
      reason,
      at,
      observability: observation(fidelity, at, turnId),
    };
  };

  return {
    capabilities,
    translate(signal) {
      const at = signal.at ?? new Date().toISOString();
      switch (signal.type) {
        case 'starting': {
          const events: PtyAgentEvent[] = [
            {
              type: 'session.starting',
              reason: 'broker_spawn',
              at,
              observability: observation('exact', at),
            },
          ];
          const changed = transition('starting', 'broker_spawn', 'exact', at);
          if (changed) events.push(changed);
          return events;
        }
        case 'busy': {
          if (activeTurnId === signal.turnId && activity === 'thinking') return [];
          activeTurnId = signal.turnId;
          const events: PtyAgentEvent[] = [
            {
              type: 'turn.started',
              turnId: signal.turnId,
              at,
              observability: observation('inferred', at, signal.turnId),
            },
          ];
          const changed = transition('thinking', 'broker_busy_boundary', 'inferred', at, signal.turnId);
          if (changed) events.push(changed);
          return events;
        }
        case 'idle': {
          if (activeTurnId !== signal.turnId) return [];
          activeTurnId = undefined;
          const events: PtyAgentEvent[] = [
            {
              type: 'turn.settled',
              turnId: signal.turnId,
              at,
              observability: observation('inferred', at, signal.turnId),
            },
          ];
          const changed = transition('idle', 'broker_idle_boundary', 'inferred', at, signal.turnId);
          if (changed) events.push(changed);
          return events;
        }
        case 'error': {
          const events: PtyAgentEvent[] = [
            {
              type: 'session.failed',
              error: signal.error,
              ...(signal.code ? { code: signal.code } : {}),
              at,
              observability: observation('exact', at, activeTurnId),
            },
          ];
          const changed = transition('error', 'broker_runtime_failure', 'exact', at, activeTurnId);
          if (changed) events.push(changed);
          return events;
        }
      }
    },
  };
}
