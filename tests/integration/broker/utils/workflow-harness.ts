import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrokerEvent } from '@agent-relay/sdk';
import { ensureApiKey, resolveBinaryPath } from './broker-harness.js';
import { type RelayYamlConfig, type VariableContext, type WorkflowRunRow } from '@agent-relay/sdk/workflows';
import { WorkflowRunner, type WorkflowEvent } from '@agent-relay/sdk/workflows';

export interface WorkflowRunResult {
  run: WorkflowRunRow;
  events: WorkflowEvent[];
  brokerEvents: BrokerEvent[];
}

export interface TrajectoryFile {
  id: string;
  version: number;
  task: {
    title: string;
    source?: {
      system: string;
      id: string;
    };
  };
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt?: string;
  agents: Array<{
    name: string;
    role: string;
    joinedAt: string;
  }>;
  chapters: Array<{
    id: string;
    title: string;
    agentName: string;
    startedAt: string;
    endedAt?: string;
    events: Array<{
      ts: number;
      type: string;
      content: string;
      raw?: Record<string, unknown>;
      significance?: 'low' | 'medium' | 'high';
    }>;
  }>;
  retrospective?: {
    summary: string;
    approach: string;
    confidence: number;
    learnings?: string[];
    challenges?: string[];
  };
}

export class WorkflowRunnerHarness {
  private fakeCliDir?: string;
  private runnerEnv?: NodeJS.ProcessEnv;
  private currentRunner?: WorkflowRunner;
  private brokerEvents: BrokerEvent[] = [];
  private binaryPath: string;
  private started = false;
  private defaultUseRelaycast = true;

  constructor() {
    this.binaryPath = resolveBinaryPath();
  }

  getBinaryPath(): string {
    return this.binaryPath;
  }

  getRelayEnv(): NodeJS.ProcessEnv {
    return this.runnerEnv ?? process.env;
  }

  getCurrentRunner(): WorkflowRunner | undefined {
    return this.currentRunner;
  }

  async start(options?: { useRelaycast?: boolean }): Promise<void> {
    if (this.started) return;

    const fakeCliDir = ensureFakeCliDir();
    const existingPath = process.env.PATH ?? '';
    const mergedPath = existingPath ? `${fakeCliDir}${path.delimiter}${existingPath}` : fakeCliDir;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: mergedPath,
    };

    this.fakeCliDir = fakeCliDir;
    this.defaultUseRelaycast = options?.useRelaycast !== false;
    this.runnerEnv = { ...env };

    if (this.defaultUseRelaycast) {
      const apiKey = await ensureApiKey();
      this.runnerEnv = {
        ...env,
        RELAY_API_KEY: apiKey,
      };
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    // Abort any in-flight workflow run so its broker handles are released.
    // Without this, node:test's timeout marks the test failed but the process
    // stays alive forever waiting on pending broker I/O.
    this.currentRunner?.abort();

    this.started = false;
    this.currentRunner = undefined;
    this.brokerEvents = [];
    if (this.fakeCliDir) {
      fs.rmSync(this.fakeCliDir, { recursive: true, force: true });
      this.fakeCliDir = undefined;
    }
  }

  /**
   * Return all broker events captured since start() (or last clearEvents call).
   */
  getEvents(): BrokerEvent[] {
    return [...this.brokerEvents];
  }

  /**
   * Clear captured broker events.
   */
  clearEvents(): void {
    this.brokerEvents = [];
  }

  /**
   * Abort the currently running workflow, if any.
   */
  abortCurrentRun(): void {
    this.currentRunner?.abort();
  }

  /**
   * Run a workflow config through the real WorkflowRunner and collect events.
   */
  async runWorkflow(
    config: RelayYamlConfig,
    vars?: VariableContext,
    options?: { workflowName?: string; cwd?: string; useRelaycast?: boolean }
  ): Promise<WorkflowRunResult> {
    const useRelaycast = options?.useRelaycast ?? this.defaultUseRelaycast;

    if (!this.started) {
      await this.start({ useRelaycast });
    } else if (useRelaycast && !this.runnerEnv?.RELAY_API_KEY) {
      this.runnerEnv = {
        ...this.runnerEnv,
        RELAY_API_KEY: await ensureApiKey(),
      };
      this.defaultUseRelaycast = true;
    }

    this.brokerEvents = [];

    const events: WorkflowEvent[] = [];
    const runner = new WorkflowRunner({
      cwd: options?.cwd,
      relay: {
        binaryPath: this.binaryPath,
        env: {
          ...this.runnerEnv,
          ...(process.env.FAKE_OUTPUT === undefined
            ? {}
            : { FAKE_OUTPUT: process.env.FAKE_OUTPUT }),
          ...(useRelaycast ? {} : { AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1' }),
        },
      },
    });
    this.currentRunner = runner;

    const unsubscribe = runner.on((event) => {
      events.push(event);
      if (event.type === 'broker:event') {
        this.brokerEvents.push(event.event);
      }
    });

    try {
      const run = await runner.execute(config, options?.workflowName, vars);
      return {
        run,
        events,
        brokerEvents: [...this.brokerEvents],
      };
    } finally {
      unsubscribe();
      this.currentRunner = undefined;
    }
  }

  /**
   * Read the latest trajectory JSON file for a workflow run.
   * Checks completed before active to prefer finished runs.
   */
  getTrajectory(cwd: string): TrajectoryFile | null {
    const completed = path.join(cwd, '.trajectories', 'completed');
    const active = path.join(cwd, '.trajectories', 'active');

    const completedTrajectory = readLatestTrajectoryFile(completed);
    if (completedTrajectory) {
      return completedTrajectory;
    }

    return readLatestTrajectoryFile(active);
  }
}

function ensureFakeCliDir(cliName = 'claude'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-cli-'));
  const script =
    '#!/usr/bin/env bash\n' +
    'FAKE_OUTPUT_SET=0\n' +
    'if [[ -n "${FAKE_OUTPUT+x}" ]]; then\n' +
    '  OUTPUT="$FAKE_OUTPUT"\n' +
    '  FAKE_OUTPUT_SET=1\n' +
    'else\n' +
    '  OUTPUT="DONE"\n' +
    'fi\n' +
    'INPUT_BUFFER="$*"$\'\\n\'\n' +
    'MARKER=""\n' +
    'REVIEW_OUTPUT=""\n' +
    'if [[ "${RELAY_AGENT_NAME:-}" =~ ^(.+)-review-[A-Za-z0-9]+$ ]]; then\n' +
    '  REVIEW_OUTPUT=$\'REVIEW_DECISION: APPROVE\\nREVIEW_REASON: Fake reviewer approved\'\n' +
    'elif [[ "${RELAY_AGENT_NAME:-}" =~ ^(.+)-(worker|owner)-[A-Za-z0-9]+$ ]]; then\n' +
    '  MARKER="STEP_COMPLETE:${BASH_REMATCH[1]}"\n' +
    'elif [[ "${RELAY_AGENT_NAME:-}" =~ ^(.+)-[A-Za-z0-9]+$ ]]; then\n' +
    '  MARKER="STEP_COMPLETE:${BASH_REMATCH[1]}"\n' +
    'fi\n' +
    'while IFS= read -r -t 1 line; do\n' +
    '  INPUT_BUFFER+="$line"$\'\\n\'\n' +
    '  if [[ "$line" =~ STEP_COMPLETE:([A-Za-z0-9._-]+) ]]; then\n' +
    '    MARKER="STEP_COMPLETE:${BASH_REMATCH[1]}"\n' +
    '  fi\n' +
    'done 2>/dev/null\n' +
    'if [[ "$FAKE_OUTPUT_SET" -eq 0 ]]; then\n' +
    '  if [[ "$INPUT_BUFFER" =~ End[[:space:]]with:[[:space:]]([A-Za-z0-9._-]+) ]]; then\n' +
    '    OUTPUT="${BASH_REMATCH[1]}"\n' +
    '  elif [[ "$INPUT_BUFFER" =~ outputting:[[:space:]]([A-Za-z0-9._-]+) ]]; then\n' +
    '    OUTPUT="${BASH_REMATCH[1]}"\n' +
    '  elif [[ "$INPUT_BUFFER" =~ Output[[:space:]]exactly:[[:space:]]([A-Za-z0-9._-]+) ]]; then\n' +
    '    OUTPUT="${BASH_REMATCH[1]}"\n' +
    '  elif [[ "$INPUT_BUFFER" =~ Print[[:space:]]([A-Za-z0-9._-]+) ]]; then\n' +
    '    OUTPUT="${BASH_REMATCH[1]}"\n' +
    '  elif [[ "$INPUT_BUFFER" =~ Return[[:space:]]([A-Za-z0-9._-]+) ]]; then\n' +
    '    OUTPUT="${BASH_REMATCH[1]}"\n' +
    '  elif [[ "$INPUT_BUFFER" =~ Say[[:space:]]([A-Za-z0-9._-]+)[[:space:]]when[[:space:]]finished ]]; then\n' +
    '    OUTPUT="${BASH_REMATCH[1]}"\n' +
    '  fi\n' +
    'fi\n' +
    'if [[ -n "$MARKER" ]]; then\n' +
    '  echo "$MARKER"\n' +
    'fi\n' +
    'if [[ -n "$REVIEW_OUTPUT" ]]; then\n' +
    '  echo "$REVIEW_OUTPUT"\n' +
    'fi\n' +
    'echo "$OUTPUT"\n' +
    'exit 0\n';

  const scriptPath = path.join(dir, cliName);
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return dir;
}

function readLatestTrajectoryFile(dir: string): TrajectoryFile | null {
  if (!fs.existsSync(dir)) {
    return null;
  }

  const files = fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => ({
      path: path.join(dir, entry),
      mtimeMs: fs.statSync(path.join(dir, entry)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files) {
    try {
      const raw = fs.readFileSync(file.path, 'utf-8');
      return JSON.parse(raw) as TrajectoryFile;
    } catch {
      // Continue to next file if parse fails.
    }
  }

  return null;
}
