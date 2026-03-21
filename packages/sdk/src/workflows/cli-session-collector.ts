import type { AgentCli } from './types.js';
import { ClaudeCodeCollector } from './collectors/claude.js';
import { CodexCollector } from './collectors/codex.js';
import { OpenCodeCollector } from './collectors/opencode.js';

export interface CliSessionReport {
  cli: AgentCli;
  sessionId: string | null;
  model: string | null;
  provider: string | null;
  durationMs: number | null;
  cost: number | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
  } | null;
  turns: number;
  toolCalls: { name: string; count: number }[];
  errors: { turn: number; text: string }[];
  finalStatus: 'completed' | 'failed' | 'unknown';
  summary: string | null;
  raw?: object;
}

export interface CliSessionQuery {
  cli: AgentCli;
  cwd: string;
  startedAt: number;
  completedAt: number;
}

export interface CliSessionCollector {
  canCollect(): boolean;
  collect(query: CliSessionQuery): Promise<CliSessionReport | null>;
}

export function createCollector(cli: AgentCli): CliSessionCollector | null {
  switch (cli) {
    case 'opencode':
      return new OpenCodeCollector();
    case 'claude':
      return new ClaudeCodeCollector();
    case 'codex':
      return new CodexCollector();
    default:
      return null;
  }
}

export async function collectCliSession(query: CliSessionQuery): Promise<CliSessionReport | null> {
  const collector = createCollector(query.cli);
  if (!collector || !collector.canCollect()) {
    return null;
  }

  return collector.collect(query);
}
