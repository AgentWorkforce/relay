import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
  AgentStateManager,
  parseStateFromOutput,
  type AgentState,
} from './agent-state.js';

function makeTempDir(): string {
  const base = path.join(process.cwd(), '.tmp-state-tests');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'state-'));
  return dir;
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('AgentStateManager', () => {
  let tempDir: string;
  let manager: AgentStateManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = new AgentStateManager(tempDir);
  });

  afterEach(() => {
    if (tempDir) {
      cleanup(tempDir);
    }
  });

  describe('load', () => {
    it('returns null when state file does not exist', () => {
      const result = manager.load('NonexistentAgent');
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const agentDir = path.join(tempDir, 'BadAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'state.json'), 'not json');
      expect(manager.load('BadAgent')).toBeNull();
    });

    it('loads state from file', () => {
      const state: AgentState = {
        name: 'TestAgent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: 'Testing',
        completedTasks: ['task1'],
        decisions: ['decision1'],
        context: 'Some context',
        files: ['file1.ts'],
      };
      const agentDir = path.join(tempDir, 'TestAgent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, 'state.json'),
        JSON.stringify(state)
      );

      const result = manager.load('TestAgent');
      expect(result).toEqual(state);
    });
  });

  describe('save', () => {
    it('creates directory if it does not exist', () => {
      const state: AgentState = {
        name: 'NewAgent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: '',
        completedTasks: [],
        decisions: [],
        context: '',
        files: [],
      };

      manager.save(state);

      const agentDir = path.join(tempDir, 'NewAgent');
      expect(fs.existsSync(agentDir)).toBe(true);
      expect(fs.existsSync(path.join(agentDir, 'state.json'))).toBe(true);
    });

    it('saves state as formatted JSON', () => {
      const state: AgentState = {
        name: 'TestAgent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: 'Working',
        completedTasks: ['done'],
        decisions: ['chose X'],
        context: 'ctx',
        files: ['f.ts'],
      };

      manager.save(state);

      const content = fs.readFileSync(
        path.join(tempDir, 'TestAgent', 'state.json'),
        'utf-8'
      );
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(state);
      // Check it's formatted (has indentation)
      expect(content).toContain('\n');
    });
  });

  describe('update', () => {
    it('creates new state if none exists', () => {
      const result = manager.update('NewAgent', { currentTask: 'New task' });

      expect(result.name).toBe('NewAgent');
      expect(result.currentTask).toBe('New task');
      expect(result.completedTasks).toEqual([]);
      expect(result.lastActive).toBeDefined();
    });

    it('merges updates with existing state', () => {
      const existing: AgentState = {
        name: 'Agent',
        lastActive: '2025-01-01T00:00:00Z',
        currentTask: 'Old task',
        completedTasks: ['task1'],
        decisions: ['d1'],
        context: 'old ctx',
        files: ['old.ts'],
      };
      const agentDir = path.join(tempDir, 'Agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, 'state.json'),
        JSON.stringify(existing)
      );

      const result = manager.update('Agent', {
        currentTask: 'New task',
        files: ['new.ts'],
      });

      expect(result.currentTask).toBe('New task');
      expect(result.files).toEqual(['new.ts']);
      expect(result.completedTasks).toEqual(['task1']); // Preserved
      expect(result.decisions).toEqual(['d1']); // Preserved
      expect(result.lastActive).not.toBe('2025-01-01T00:00:00Z'); // Updated
    });

    it('always updates lastActive timestamp', () => {
      const before = new Date().toISOString();
      const result = manager.update('Agent', {});
      const after = new Date().toISOString();

      expect(result.lastActive >= before).toBe(true);
      expect(result.lastActive <= after).toBe(true);
    });
  });

  describe('formatAsContext', () => {
    it('returns default message when no state exists', () => {
      const result = manager.formatAsContext('NoAgent');
      expect(result).toBe('No previous session state found. Starting fresh.');
    });

    it('formats basic state info', () => {
      const state: AgentState = {
        name: 'Agent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: '',
        completedTasks: [],
        decisions: [],
        context: '',
        files: [],
      };
      const agentDir = path.join(tempDir, 'Agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify(state));

      const result = manager.formatAsContext('Agent');

      expect(result).toContain('=== PREVIOUS SESSION CONTEXT ===');
      expect(result).toContain('Last active: 2025-01-01T10:00:00Z');
      expect(result).toContain('=== END CONTEXT ===');
    });

    it('includes current task when present', () => {
      const state: AgentState = {
        name: 'Agent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: 'Working on feature X',
        completedTasks: [],
        decisions: [],
        context: '',
        files: [],
      };
      const agentDir = path.join(tempDir, 'Agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify(state));

      const result = manager.formatAsContext('Agent');

      expect(result).toContain('Current task: Working on feature X');
    });

    it('includes completed tasks when present', () => {
      const state: AgentState = {
        name: 'Agent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: '',
        completedTasks: ['Setup project', 'Write tests'],
        decisions: [],
        context: '',
        files: [],
      };
      const agentDir = path.join(tempDir, 'Agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify(state));

      const result = manager.formatAsContext('Agent');

      expect(result).toContain('Completed tasks:');
      expect(result).toContain('  - Setup project');
      expect(result).toContain('  - Write tests');
    });

    it('includes decisions when present', () => {
      const state: AgentState = {
        name: 'Agent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: '',
        completedTasks: [],
        decisions: ['Use TypeScript', 'Chose vitest'],
        context: '',
        files: [],
      };
      const agentDir = path.join(tempDir, 'Agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify(state));

      const result = manager.formatAsContext('Agent');

      expect(result).toContain('Key decisions made:');
      expect(result).toContain('  - Use TypeScript');
      expect(result).toContain('  - Chose vitest');
    });

    it('includes context when present', () => {
      const state: AgentState = {
        name: 'Agent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: '',
        completedTasks: [],
        decisions: [],
        context: 'Working on auth module refactor',
        files: [],
      };
      const agentDir = path.join(tempDir, 'Agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify(state));

      const result = manager.formatAsContext('Agent');

      expect(result).toContain('Context:');
      expect(result).toContain('Working on auth module refactor');
    });

    it('includes files when present', () => {
      const state: AgentState = {
        name: 'Agent',
        lastActive: '2025-01-01T10:00:00Z',
        currentTask: '',
        completedTasks: [],
        decisions: [],
        context: '',
        files: ['src/auth.ts', 'src/utils.ts'],
      };
      const agentDir = path.join(tempDir, 'Agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'state.json'), JSON.stringify(state));

      const result = manager.formatAsContext('Agent');

      expect(result).toContain('Files being worked on:');
      expect(result).toContain('  - src/auth.ts');
      expect(result).toContain('  - src/utils.ts');
    });
  });
});

describe('parseStateFromOutput', () => {
  it('returns null when no state block found', () => {
    const output = 'Just some regular output without state';
    expect(parseStateFromOutput(output)).toBeNull();
  });

  it('parses state from output with state block', () => {
    const output = `
Some output before
[[STATE]]{"currentTask": "Testing", "context": "Working on tests"}[[/STATE]]
Some output after
`;
    const result = parseStateFromOutput(output);
    expect(result).toEqual({
      currentTask: 'Testing',
      context: 'Working on tests',
    });
  });

  it('returns null for invalid JSON in state block', () => {
    const output = '[[STATE]]not valid json[[/STATE]]';
    expect(parseStateFromOutput(output)).toBeNull();
  });

  it('handles multiline state blocks', () => {
    const output = `
[[STATE]]
{
  "currentTask": "Multi",
  "completedTasks": ["one", "two"]
}
[[/STATE]]
`;
    const result = parseStateFromOutput(output);
    expect(result).toEqual({
      currentTask: 'Multi',
      completedTasks: ['one', 'two'],
    });
  });
});
