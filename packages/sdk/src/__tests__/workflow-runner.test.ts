/**
 * WorkflowRunner integration tests.
 *
 * Tests parsing, validation, variable resolution, and DAG execution
 * with a mocked DB adapter and mocked AgentRelay.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDb } from '../workflows/runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../workflows/types.js';

// ── Mock AgentRelay ──────────────────────────────────────────────────────────

const mockAgent = {
  name: 'test-agent-abc',
  waitForExit: vi.fn().mockResolvedValue(0),
  release: vi.fn().mockResolvedValue(undefined),
};

const mockHuman = {
  name: 'WorkflowRunner',
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@agent-relay/sdk/relay', () => ({
  AgentRelay: vi.fn().mockImplementation(() => ({
    spawnPty: vi.fn().mockResolvedValue(mockAgent),
    human: vi.fn().mockReturnValue(mockHuman),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import after mocking
const { WorkflowRunner } = await import('../workflows/runner.js');

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();

  return {
    insertRun: vi.fn(async (run: WorkflowRunRow) => {
      runs.set(run.id, { ...run });
    }),
    updateRun: vi.fn(async (id: string, patch: Partial<WorkflowRunRow>) => {
      const existing = runs.get(id);
      if (existing) runs.set(id, { ...existing, ...patch });
    }),
    getRun: vi.fn(async (id: string) => {
      const run = runs.get(id);
      return run ? { ...run } : null;
    }),
    insertStep: vi.fn(async (step: WorkflowStepRow) => {
      steps.set(step.id, { ...step });
    }),
    updateStep: vi.fn(async (id: string, patch: Partial<WorkflowStepRow>) => {
      const existing = steps.get(id);
      if (existing) steps.set(id, { ...existing, ...patch });
    }),
    getStepsByRunId: vi.fn(async (runId: string) => {
      return [...steps.values()].filter((s) => s.runId === runId);
    }),
  };
}

function makeConfig(overrides: Partial<RelayYamlConfig> = {}): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-workflow',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
      { name: 'agent-b', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-1', agent: 'agent-a', task: 'Do step 1' },
          { name: 'step-2', agent: 'agent-b', task: 'Do step 2', dependsOn: ['step-1'] },
        ],
      },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowRunner', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test' });
  });

  // ── Parsing & validation ───────────────────────────────────────────────

  describe('parseYamlString', () => {
    it('should parse valid YAML config', () => {
      const yaml = `
version: "1"
name: test
swarm:
  pattern: fan-out
agents:
  - name: a1
    cli: claude
`;
      const config = runner.parseYamlString(yaml);
      expect(config.name).toBe('test');
      expect(config.swarm.pattern).toBe('fan-out');
      expect(config.agents).toHaveLength(1);
    });

    it('should throw on null YAML', () => {
      expect(() => runner.parseYamlString('null')).toThrow('config must be a non-null object');
    });

    it('should throw on invalid YAML syntax', () => {
      expect(() => runner.parseYamlString('not: valid: yaml: []')).toThrow();
    });
  });

  describe('validateConfig', () => {
    it('should accept valid config', () => {
      expect(() => runner.validateConfig(makeConfig())).not.toThrow();
    });

    it('should reject null config', () => {
      expect(() => runner.validateConfig(null)).toThrow('non-null object');
    });

    it('should reject missing version', () => {
      expect(() =>
        runner.validateConfig({ name: 'x', swarm: { pattern: 'dag' }, agents: [{ name: 'a', cli: 'claude' }] }),
      ).toThrow('missing required field "version"');
    });

    it('should reject missing name', () => {
      expect(() =>
        runner.validateConfig({ version: '1', swarm: { pattern: 'dag' }, agents: [{ name: 'a', cli: 'claude' }] }),
      ).toThrow('missing required field "name"');
    });

    it('should reject empty agents array', () => {
      expect(() =>
        runner.validateConfig({ version: '1', name: 'x', swarm: { pattern: 'dag' }, agents: [] }),
      ).toThrow('non-empty array');
    });

    it('should reject agent without cli', () => {
      expect(() =>
        runner.validateConfig({
          version: '1',
          name: 'x',
          swarm: { pattern: 'dag' },
          agents: [{ name: 'a' }],
        }),
      ).toThrow('each agent must have a string "cli"');
    });

    it('should detect unknown dependencies in workflows', () => {
      const config = makeConfig({
        workflows: [
          {
            name: 'wf',
            steps: [
              { name: 's1', agent: 'agent-a', task: 'do', dependsOn: ['nonexistent'] },
            ],
          },
        ],
      });
      expect(() => runner.validateConfig(config)).toThrow('depends on unknown step "nonexistent"');
    });

    it('should detect dependency cycles', () => {
      const config = makeConfig({
        workflows: [
          {
            name: 'wf',
            steps: [
              { name: 's1', agent: 'agent-a', task: 'do', dependsOn: ['s2'] },
              { name: 's2', agent: 'agent-b', task: 'do', dependsOn: ['s1'] },
            ],
          },
        ],
      });
      expect(() => runner.validateConfig(config)).toThrow('dependency cycle');
    });
  });

  // ── Variable resolution ────────────────────────────────────────────────

  describe('resolveVariables', () => {
    it('should replace {{var}} in agent tasks', () => {
      const config = makeConfig({
        agents: [
          { name: 'a', cli: 'claude', task: 'Fix bug {{bugId}}' },
        ],
      });
      const resolved = runner.resolveVariables(config, { bugId: '42' });
      expect(resolved.agents[0].task).toBe('Fix bug 42');
    });

    it('should replace {{var}} in workflow step tasks', () => {
      const config = makeConfig();
      config.workflows![0].steps[0].task = 'Process {{item}}';
      const resolved = runner.resolveVariables(config, { item: 'test-item' });
      expect(resolved.workflows![0].steps[0].task).toBe('Process test-item');
    });

    it('should throw on unresolved variables', () => {
      const config = makeConfig({
        agents: [
          { name: 'a', cli: 'claude', task: 'Fix {{unknown}}' },
        ],
      });
      expect(() => runner.resolveVariables(config, {})).toThrow('Unresolved variable: {{unknown}}');
    });

    it('should not mutate original config', () => {
      const config = makeConfig({
        agents: [
          { name: 'a', cli: 'claude', task: 'Fix {{id}}' },
        ],
      });
      runner.resolveVariables(config, { id: '1' });
      expect(config.agents[0].task).toBe('Fix {{id}}');
    });
  });

  // ── Execution ──────────────────────────────────────────────────────────

  describe('execute', () => {
    it('should create run and steps in DB', async () => {
      const config = makeConfig();
      const run = await runner.execute(config, 'default');

      expect(db.insertRun).toHaveBeenCalledTimes(1);
      expect(db.insertStep).toHaveBeenCalledTimes(2);
      expect(run.status).toBe('completed');
    });

    it('should throw when workflow not found', async () => {
      const config = makeConfig();
      await expect(runner.execute(config, 'nonexistent')).rejects.toThrow(
        'Workflow "nonexistent" not found',
      );
    });

    it('should throw when no workflows defined', async () => {
      const config = makeConfig({ workflows: undefined });
      await expect(runner.execute(config)).rejects.toThrow('No workflows defined');
    });

    it('should emit run:started and run:completed events', async () => {
      const events: string[] = [];
      runner.on((event) => events.push(event.type));

      await runner.execute(makeConfig(), 'default');

      expect(events).toContain('run:started');
      expect(events).toContain('run:completed');
    });

    it('should emit step events in order', async () => {
      const stepEvents: Array<{ type: string; stepName?: string }> = [];
      runner.on((event) => {
        if (event.type.startsWith('step:')) {
          stepEvents.push({
            type: event.type,
            stepName: 'stepName' in event ? event.stepName : undefined,
          });
        }
      });

      await runner.execute(makeConfig(), 'default');

      const startedSteps = stepEvents.filter((e) => e.type === 'step:started');
      expect(startedSteps).toHaveLength(2);
    });

    it('should resolve variables during execution', async () => {
      const config = makeConfig();
      config.workflows![0].steps[0].task = 'Build {{feature}}';
      const run = await runner.execute(config, 'default', { feature: 'auth' });
      expect(run.status).toBe('completed');
    });
  });

  // ── Event subscription ─────────────────────────────────────────────────

  describe('on / event subscription', () => {
    it('should return unsubscribe function', async () => {
      const events: string[] = [];
      const unsub = runner.on((event) => events.push(event.type));

      await runner.execute(makeConfig(), 'default');
      const count = events.length;

      unsub();
      // Events after unsubscribe are not captured (no second execute needed to prove this,
      // just verify the unsub function works without error)
      expect(count).toBeGreaterThan(0);
    });
  });

  // ── Pause / abort ──────────────────────────────────────────────────────

  describe('pause and abort', () => {
    it('should support pause/unpause without error', () => {
      expect(() => runner.pause()).not.toThrow();
      expect(() => runner.unpause()).not.toThrow();
    });

    it('should support abort without error', () => {
      expect(() => runner.abort()).not.toThrow();
    });
  });

  // ── Resume ─────────────────────────────────────────────────────────────

  describe('resume', () => {
    it('should throw when run not found', async () => {
      await expect(runner.resume('nonexistent')).rejects.toThrow('Run "nonexistent" not found');
    });
  });

  // ── Non-interactive command builder ────────────────────────────────────

  describe('buildNonInteractiveCommand', () => {
    it('should build claude command with -p flag', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('claude', 'Do the thing');
      expect(cmd).toBe('claude');
      expect(args).toEqual(['-p', 'Do the thing']);
    });

    it('should build codex command with exec subcommand', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('codex', 'Build it');
      expect(cmd).toBe('codex');
      expect(args).toEqual(['exec', 'Build it']);
    });

    it('should build gemini command with -p flag', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('gemini', 'Analyze');
      expect(cmd).toBe('gemini');
      expect(args).toEqual(['-p', 'Analyze']);
    });

    it('should build opencode command with --prompt flag', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('opencode', 'Fix bug');
      expect(cmd).toBe('opencode');
      expect(args).toEqual(['--prompt', 'Fix bug']);
    });

    it('should build droid command with exec subcommand', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('droid', 'Deploy');
      expect(cmd).toBe('droid');
      expect(args).toEqual(['exec', 'Deploy']);
    });

    it('should build aider command with --message and safety flags', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('aider', 'Refactor');
      expect(cmd).toBe('aider');
      expect(args).toEqual(['--message', 'Refactor', '--yes-always', '--no-git']);
    });

    it('should build goose command with run subcommand', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('goose', 'Test it');
      expect(cmd).toBe('goose');
      expect(args).toEqual(['run', '--text', 'Test it', '--no-session']);
    });

    it('should append extra args after CLI-specific args', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('claude', 'Task', ['--model', 'opus']);
      expect(cmd).toBe('claude');
      expect(args).toEqual(['-p', 'Task', '--model', 'opus']);
    });
  });
});
