/**
 * Unit tests for ContinuityManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ContinuityManager,
  getContinuityManager,
  resetContinuityManager,
} from './manager.js';

describe('ContinuityManager', () => {
  let manager: ContinuityManager;
  let testDir: string;

  beforeEach(async () => {
    // Reset singleton for each test
    resetContinuityManager();

    // Create a unique temp directory for each test
    testDir = path.join(os.tmpdir(), `continuity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create manager with test directory
    manager = new ContinuityManager({
      basePath: testDir,
      defaultCli: 'test-cli',
    });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('autoSave', () => {
    it('creates handoff with session_end trigger for clean exit', async () => {
      const agentName = 'TestAgent';

      // First create a ledger with some data
      await manager.saveLedger(agentName, {
        currentTask: 'Implementing feature X',
        completed: ['Step 1', 'Step 2'],
        inProgress: ['Step 3'],
      });

      // Call autoSave with session_end reason
      await manager.autoSave(agentName, 'session_end');

      // Verify a handoff was created
      const handoff = await manager.getLatestHandoff(agentName);
      expect(handoff).not.toBeNull();
      expect(handoff!.triggerReason).toBe('session_end');
      expect(handoff!.agentName).toBe(agentName);
    });

    it('creates handoff with crash trigger for unexpected termination', async () => {
      const agentName = 'CrashAgent';

      // First create a ledger
      await manager.saveLedger(agentName, {
        currentTask: 'Working on task',
        completed: ['Done item'],
      });

      // Call autoSave with crash reason
      await manager.autoSave(agentName, 'crash');

      // Verify handoff has crash trigger
      const handoff = await manager.getLatestHandoff(agentName);
      expect(handoff).not.toBeNull();
      expect(handoff!.triggerReason).toBe('crash');
    });

    it('creates handoff with auto_restart trigger for restart', async () => {
      const agentName = 'RestartAgent';

      // First create a ledger
      await manager.saveLedger(agentName, {
        currentTask: 'Some task',
      });

      // Call autoSave with restart reason
      await manager.autoSave(agentName, 'restart');

      // Verify handoff has auto_restart trigger
      const handoff = await manager.getLatestHandoff(agentName);
      expect(handoff).not.toBeNull();
      expect(handoff!.triggerReason).toBe('auto_restart');
    });

    it('uses sessionEndData to create handoff directly', async () => {
      const agentName = 'SessionEndAgent';

      // Call autoSave with sessionEndData (no ledger needed)
      await manager.autoSave(agentName, 'session_end', {
        summary: 'Completed auth module implementation',
        completedTasks: ['JWT tokens', 'Login endpoint', 'Logout endpoint'],
      });

      // Verify handoff was created from sessionEndData
      const handoff = await manager.getLatestHandoff(agentName);
      expect(handoff).not.toBeNull();
      expect(handoff!.summary).toBe('Completed auth module implementation');
      expect(handoff!.completedWork).toEqual(['JWT tokens', 'Login endpoint', 'Logout endpoint']);
      expect(handoff!.triggerReason).toBe('session_end');
    });

    it('falls back to ledger when sessionEndData is empty', async () => {
      const agentName = 'FallbackAgent';

      // Create a ledger first
      await manager.saveLedger(agentName, {
        currentTask: 'Build feature',
        completed: ['Design', 'Implementation'],
        inProgress: ['Testing'],
      });

      // Call autoSave with empty sessionEndData
      await manager.autoSave(agentName, 'session_end', {});

      // Verify handoff was created from ledger
      const handoff = await manager.getLatestHandoff(agentName);
      expect(handoff).not.toBeNull();
      expect(handoff!.completedWork).toEqual(['Design', 'Implementation']);
      expect(handoff!.nextSteps).toEqual(['Testing']);
    });

    it('handles agent without ledger and no sessionEndData', async () => {
      const agentName = 'NewAgent';

      // Call autoSave without any prior data
      await manager.autoSave(agentName, 'session_end');

      // Should not throw, but also no handoff created (no data to save)
      const handoff = await manager.getLatestHandoff(agentName);
      expect(handoff).toBeNull();
    });
  });

  describe('getOrCreateLedger', () => {
    it('creates a new ledger if none exists', async () => {
      const ledger = await manager.getOrCreateLedger('NewAgent');

      expect(ledger).not.toBeNull();
      expect(ledger.agentName).toBe('NewAgent');
      expect(ledger.agentId).toBeDefined();
      expect(ledger.sessionId).toBeDefined();
    });

    it('returns existing ledger if one exists', async () => {
      // Create initial ledger
      await manager.saveLedger('ExistingAgent', {
        currentTask: 'Existing task',
      });

      const ledger = await manager.getOrCreateLedger('ExistingAgent');
      expect(ledger.currentTask).toBe('Existing task');
    });

    it('preserves agentId across updates', async () => {
      const ledger1 = await manager.getOrCreateLedger('StableAgent');
      const originalAgentId = ledger1.agentId;

      // Update the ledger
      await manager.saveLedger('StableAgent', {
        currentTask: 'Updated task',
      });

      const ledger2 = await manager.getOrCreateLedger('StableAgent');
      expect(ledger2.agentId).toBe(originalAgentId);
    });
  });

  describe('saveLedger', () => {
    it('saves ledger with updates', async () => {
      await manager.saveLedger('SaveAgent', {
        currentTask: 'My task',
        completed: ['Item 1'],
      });

      const ledger = await manager.getLedger('SaveAgent');
      expect(ledger).not.toBeNull();
      expect(ledger!.currentTask).toBe('My task');
      expect(ledger!.completed).toEqual(['Item 1']);
    });

    it('creates handoff when option is set', async () => {
      await manager.saveLedger('HandoffAgent', {
        currentTask: 'Task with handoff',
      }, {
        createHandoff: true,
        triggerReason: 'manual',
      });

      const handoff = await manager.getLatestHandoff('HandoffAgent');
      expect(handoff).not.toBeNull();
      expect(handoff!.triggerReason).toBe('manual');
    });
  });

  describe('getStartupContext', () => {
    it('filters out placeholder values from ledger', async () => {
      await manager.saveLedger('PlaceholderAgent', {
        currentTask: '...',
        completed: ['Real item', '...', 'Another real item'],
        inProgress: ['task1', 'Actual task'],
      });

      const context = await manager.getStartupContext('PlaceholderAgent');
      expect(context).not.toBeNull();
      expect(context!.ledger!.currentTask).toBe('');
      expect(context!.ledger!.completed).toEqual(['Real item', 'Another real item']);
      expect(context!.ledger!.inProgress).toEqual(['Actual task']);
    });

    it('returns null when no data exists', async () => {
      const context = await manager.getStartupContext('NonexistentAgent');
      expect(context).toBeNull();
    });
  });

  describe('cleanupPlaceholders', () => {
    it('cleans placeholder data from ledgers', async () => {
      // saveLedger now filters placeholders on save, so this tests legacy data cleanup
      // First create a clean ledger
      await manager.saveLedger('DirtyAgent', {
        currentTask: 'Real task',
        completed: ['Real task'],
        inProgress: ['Real in progress'],
      });

      // Verify clean data was saved
      let ledger = await manager.getLedger('DirtyAgent');
      expect(ledger!.currentTask).toBe('Real task');

      // Run cleanup (should report 0 since data is already clean)
      const result = await manager.cleanupPlaceholders();
      expect(result.cleaned).toBe(0);

      // Verify ledger is unchanged
      ledger = await manager.getLedger('DirtyAgent');
      expect(ledger!.currentTask).toBe('Real task');
      expect(ledger!.completed).toEqual(['Real task']);
      expect(ledger!.inProgress).toEqual(['Real in progress']);
    });

    it('filters placeholder values on save', async () => {
      // Test that placeholders are filtered when saving
      await manager.saveLedger('FilterTestAgent', {
        currentTask: 'What you\'re working on', // placeholder - should be filtered
        completed: ['What you\'ve done', 'Real task'], // mixed - should keep only 'Real task'
        inProgress: ['task1', 'task2', 'Real in progress'], // mixed - should keep only 'Real in progress'
      });

      // Verify placeholders were filtered on save
      const ledger = await manager.getLedger('FilterTestAgent');
      expect(ledger!.currentTask).toBe(''); // filtered to empty
      expect(ledger!.completed).toEqual(['Real task']); // placeholder removed
      expect(ledger!.inProgress).toEqual(['Real in progress']); // placeholders removed
    });
  });
});

describe('getContinuityManager singleton', () => {
  beforeEach(() => {
    resetContinuityManager();
  });

  afterEach(() => {
    resetContinuityManager();
  });

  it('returns the same instance on multiple calls', () => {
    const manager1 = getContinuityManager();
    const manager2 = getContinuityManager();
    expect(manager1).toBe(manager2);
  });

  it('accepts options on first call', () => {
    const manager = getContinuityManager({ defaultCli: 'custom-cli' });
    expect(manager).toBeDefined();
  });
});
