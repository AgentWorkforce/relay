import type { SelectedHarnessRuntime } from '@agent-relay/harnesses';

// Verified against Codex 0.153.4, Claude Code 2.1.266, and Grok 1.0.24
// on 2026-09-09. Keep provider vocabularies distinct: never downgrade a request.
const LEVELS: Record<string, readonly string[]> = {
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['low', 'medium', 'high', 'xhigh'],
};

/** Validate before connecting/spawning and translate only for a supported runtime. */
export function spawnReasoningArgs(
  cli: string,
  reasoning: string | undefined,
  runtime: SelectedHarnessRuntime
): string[] {
  if (reasoning === undefined) return [];
  const levels = Object.hasOwn(LEVELS, cli) ? LEVELS[cli] : undefined;
  if (!levels) {
    throw new Error(
      `--reasoning is not supported for harness "${cli}"; no verified reasoning control is available.`
    );
  }
  if (!levels.includes(reasoning)) {
    throw new Error(
      `Invalid --reasoning level "${reasoning}" for ${cli}. Expected one of: ${levels.join(', ')}.`
    );
  }
  if (runtime !== 'pty') {
    throw new Error(`--reasoning is not supported for ${cli} with runtime "${runtime}"; use --runtime pty.`);
  }
  switch (cli) {
    case 'codex':
      return ['-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`];
    case 'claude':
      return ['--effort', reasoning];
    case 'grok':
      return ['--reasoning-effort', reasoning];
    default:
      throw new Error(`No reasoning argument translation for ${cli}.`);
  }
}
