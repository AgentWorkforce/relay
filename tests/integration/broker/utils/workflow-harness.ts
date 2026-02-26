import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrokerEvent } from '@agent-relay/sdk';
import { BrokerHarness, resolveBinaryPath } from './broker-harness.js';
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
  private brokerHarness = new BrokerHarness();
  private fakeCliDir?: string;
  private runnerEnv?: NodeJS.ProcessEnv;
  private currentRunner?: WorkflowRunner;
  private binaryPath: string;
  private started = false;

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

  async start(): Promise<void> {
    if (this.started) return;

    const fakeCliDir = ensureFakeCliDir();
    const existingPath = process.env.PATH ?? '';
    const mergedPath = existingPath ? `${fakeCliDir}${path.delimiter}${existingPath}` : fakeCliDir;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: mergedPath,
    };

    this.fakeCliDir = fakeCliDir;
    this.runnerEnv = env;

    this.brokerHarness = new BrokerHarness({
      binaryPath: this.binaryPath,
      env,
    });

    await this.brokerHarness.start();
    // Share the effective environment with the WorkflowRunner, including the
    // ephemeral API key provisioned by BrokerHarness/ensureApiKey().
    this.runnerEnv = {
      ...env,
      RELAY_API_KEY: process.env.RELAY_API_KEY ?? env.RELAY_API_KEY,
    };
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    await this.brokerHarness.stop();
    this.started = false;
    this.currentRunner = undefined;
    if (this.fakeCliDir) {
      fs.rmSync(this.fakeCliDir, { recursive: true, force: true });
      this.fakeCliDir = undefined;
    }
  }

  /**
   * Return all broker events captured since start() (or last clearEvents call).
   */
  getEvents(): BrokerEvent[] {
    if (!this.started) return [];
    return this.brokerHarness.getEvents();
  }

  /**
   * Clear captured broker events.
   */
  clearEvents(): void {
    if (this.started) {
      this.brokerHarness.clearEvents();
    }
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
    options?: { workflowName?: string; cwd?: string }
  ): Promise<WorkflowRunResult> {
    if (!this.started) {
      await this.start();
    }

    this.brokerHarness.clearEvents();

    const events: WorkflowEvent[] = [];
    const runner = new WorkflowRunner({
      cwd: options?.cwd,
      relay: {
        binaryPath: this.binaryPath,
        env: this.runnerEnv,
      },
    });
    this.currentRunner = runner;

    const unsubscribe = runner.on((event) => {
      events.push(event);
    });

    try {
      const run = await runner.execute(config, options?.workflowName, vars);
      return {
        run,
        events,
        brokerEvents: this.brokerHarness.getEvents(),
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
    'OUTPUT="${FAKE_OUTPUT:-DONE}"\n' +
    'while IFS= read -r -t 1 line; do :; done 2>/dev/null\n' +
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
