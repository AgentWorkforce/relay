/**
 * Tests for BaseWrapper abstract class
 *
 * These tests verify the shared functionality extracted
 * from PtyWrapper and TmuxWrapper into a common base class.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BaseWrapper } from './base-wrapper.js';
import type { QueuedMessage } from './shared.js';
import type { ParsedSummary } from './parser.js';
import type { SendPayload, SendMeta } from '@agent-relay/protocol/types';

// Mock the client module
vi.mock('./client.js', () => ({
  RelayClient: vi.fn().mockImplementation((name: string, _options?: any) => ({
    name,
    state: 'READY' as string,
    sentMessages: [] as Array<{ to: string; body: string; kind: string; meta?: unknown }>,
    onMessage: null as ((from: string, payload: any, messageId: string, meta?: any, originalTo?: string) => void) | null,
    sendMessage: vi.fn().mockImplementation(function(this: any, to: string, body: string, kind: string, meta?: unknown) {
      this.sentMessages.push({ to, body, kind, meta });
      return true;
    }),
    destroy: vi.fn(),
  })),
}));

// Mock the continuity module
vi.mock('@agent-relay/continuity', () => ({
  getContinuityManager: vi.fn(() => mockContinuityManager),
  parseContinuityCommand: vi.fn(),
  hasContinuityCommand: vi.fn(() => false),
}));

// Mock continuity manager instance
const mockContinuityManager = {
  ledgers: new Map<string, any>(),
  savedSummaries: [] as Array<{ agentName: string; updates: any }>,

  async getOrCreateLedger(agentName: string, cli: string) {
    if (!this.ledgers.has(agentName)) {
      this.ledgers.set(agentName, {
        agentName,
        agentId: `test-agent-id-${agentName}`,
        cli,
      });
    }
    return this.ledgers.get(agentName);
  },

  async findLedgerByAgentId(agentId: string) {
    for (const ledger of this.ledgers.values()) {
      if (ledger.agentId === agentId) return ledger;
    }
    return null;
  },

  async saveLedger(agentName: string, updates: any) {
    this.savedSummaries.push({ agentName, updates });
  },

  async handleCommand() {
    return null;
  },

  // Reset for tests
  reset() {
    this.ledgers.clear();
    this.savedSummaries = [];
  },
};

/**
 * Concrete test implementation of BaseWrapper
 */
class TestWrapper extends BaseWrapper {
  // Track calls for testing
  spawnCalls: Array<{ name: string; cli: string; task: string }> = [];
  releaseCalls: string[] = [];
  injectedMessages: string[] = [];

  // Expose protected members for testing
  get testMessageQueue(): QueuedMessage[] {
    return this.messageQueue;
  }

  get testReceivedMessageIds(): Set<string> {
    return this.receivedMessageIds;
  }

  get testSentMessageHashes(): Set<string> {
    return this.sentMessageHashes;
  }

  get testProcessedSpawnCommands(): Set<string> {
    return this.processedSpawnCommands;
  }

  get testProcessedReleaseCommands(): Set<string> {
    return this.processedReleaseCommands;
  }

  get testClient() {
    return this.client;
  }

  get testSessionEndProcessed(): boolean {
    return this.sessionEndProcessed;
  }

  set testSessionEndProcessed(value: boolean) {
    this.sessionEndProcessed = value;
  }

  get testLastSummaryRawContent(): string {
    return this.lastSummaryRawContent;
  }

  set testLastSummaryRawContent(value: string) {
    this.lastSummaryRawContent = value;
  }

  get testSessionEndData() {
    return this.sessionEndData;
  }

  set testSessionEndData(value: any) {
    this.sessionEndData = value;
  }

  get testContinuity() {
    return this.continuity;
  }

  get testConfig() {
    return this.config;
  }

  get testAgentId() {
    return this.agentId;
  }

  // Abstract method implementations
  async start(): Promise<void> {
    this.running = true;
    await this.initializeAgentId();
  }

  stop(): void {
    this.running = false;
  }

  protected async performInjection(content: string): Promise<void> {
    this.injectedMessages.push(content);
  }

  protected getCleanOutput(): string {
    return '';
  }

  // Expose protected methods for testing
  testHandleIncomingMessage(
    from: string,
    payload: SendPayload,
    messageId: string,
    meta?: SendMeta,
    originalTo?: string
  ): void {
    this.handleIncomingMessage(from, payload, messageId, meta, originalTo);
  }

  testSendRelayCommand(cmd: { to: string; body: string; thread?: string }): void {
    this.sendRelayCommand(cmd);
  }

  testParseSpawnReleaseCommands(content: string): void {
    this.parseSpawnReleaseCommands(content);
  }

  async testSaveSummaryToLedger(summary: ParsedSummary): Promise<void> {
    await this.saveSummaryToLedger(summary);
  }

  testJoinContinuationLines(content: string): string {
    return this.joinContinuationLines(content);
  }

  // Override executeSpawn/Release to track calls instead of making HTTP requests
  protected async executeSpawn(name: string, cli: string, task: string): Promise<void> {
    this.spawnCalls.push({ name, cli, task });
    if (this.config.onSpawn) {
      await this.config.onSpawn(name, cli, task);
    }
  }

  protected async executeRelease(name: string): Promise<void> {
    this.releaseCalls.push(name);
    if (this.config.onRelease) {
      await this.config.onRelease(name);
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('BaseWrapper', () => {
  let wrapper: TestWrapper;

  beforeEach(() => {
    // Reset mock continuity manager state
    mockContinuityManager.reset();

    wrapper = new TestWrapper({
      name: 'TestAgent',
      command: 'claude',
    });
  });

  afterEach(() => {
    wrapper.stop();
  });

  describe('message queue management', () => {
    it('queues incoming messages', () => {
      wrapper.testHandleIncomingMessage(
        'Sender',
        { body: 'Hello', kind: 'message' },
        'msg-1'
      );

      expect(wrapper.testMessageQueue).toHaveLength(1);
      expect(wrapper.testMessageQueue[0].from).toBe('Sender');
      expect(wrapper.testMessageQueue[0].body).toBe('Hello');
    });

    it('deduplicates messages by ID', () => {
      wrapper.testHandleIncomingMessage(
        'Sender',
        { body: 'Hello', kind: 'message' },
        'msg-1'
      );
      wrapper.testHandleIncomingMessage(
        'Sender',
        { body: 'Hello again', kind: 'message' },
        'msg-1' // Same ID
      );

      expect(wrapper.testMessageQueue).toHaveLength(1);
    });

    it('allows different messages with different IDs', () => {
      wrapper.testHandleIncomingMessage(
        'Sender',
        { body: 'Hello', kind: 'message' },
        'msg-1'
      );
      wrapper.testHandleIncomingMessage(
        'Sender',
        { body: 'World', kind: 'message' },
        'msg-2'
      );

      expect(wrapper.testMessageQueue).toHaveLength(2);
    });

    it('preserves message metadata', () => {
      wrapper.testHandleIncomingMessage(
        'Sender',
        { body: 'Hello', kind: 'message', thread: 'thread-1' },
        'msg-1',
        { importance: 80 }
      );

      expect(wrapper.testMessageQueue[0].thread).toBe('thread-1');
      expect(wrapper.testMessageQueue[0].importance).toBe(80);
    });

    it('limits dedup set size', () => {
      // Add 1001 messages to trigger cleanup
      for (let i = 0; i < 1001; i++) {
        wrapper.testHandleIncomingMessage(
          'Sender',
          { body: `Message ${i}`, kind: 'message' },
          `msg-${i}`
        );
      }

      // Set should not grow unbounded
      expect(wrapper.testReceivedMessageIds.size).toBeLessThanOrEqual(1001);
    });
  });

  describe('spawn/release handling', () => {
    it('parses single-line spawn commands', () => {
      wrapper.testParseSpawnReleaseCommands(
        '->relay:spawn Worker claude "implement auth"'
      );

      expect(wrapper.spawnCalls).toHaveLength(1);
      expect(wrapper.spawnCalls[0]).toEqual({
        name: 'Worker',
        cli: 'claude',
        task: 'implement auth',
      });
    });

    it('parses fenced spawn commands', () => {
      wrapper.testParseSpawnReleaseCommands(
        '->relay:spawn Worker claude <<<\nImplement authentication\nwith JWT tokens\n>>>'
      );

      expect(wrapper.spawnCalls).toHaveLength(1);
      expect(wrapper.spawnCalls[0].name).toBe('Worker');
      expect(wrapper.spawnCalls[0].task).toContain('Implement authentication');
    });

    it('deduplicates spawn commands', () => {
      wrapper.testParseSpawnReleaseCommands(
        '->relay:spawn Worker claude "task"'
      );
      wrapper.testParseSpawnReleaseCommands(
        '->relay:spawn Worker claude "task"' // Same command
      );

      expect(wrapper.spawnCalls).toHaveLength(1);
    });

    it('calls onSpawn callback', async () => {
      const onSpawn = vi.fn();
      wrapper.testConfig.onSpawn = onSpawn;

      wrapper.testParseSpawnReleaseCommands(
        '->relay:spawn Worker claude "task"'
      );

      // Wait for async callback
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onSpawn).toHaveBeenCalledWith('Worker', 'claude', 'task');
    });

    it('parses release commands', () => {
      wrapper.testParseSpawnReleaseCommands('->relay:release Worker');

      expect(wrapper.releaseCalls).toHaveLength(1);
      expect(wrapper.releaseCalls[0]).toBe('Worker');
    });

    it('deduplicates release commands', () => {
      wrapper.testParseSpawnReleaseCommands('->relay:release Worker');
      wrapper.testParseSpawnReleaseCommands('->relay:release Worker');

      expect(wrapper.releaseCalls).toHaveLength(1);
    });

    it('calls onRelease callback', async () => {
      const onRelease = vi.fn();
      wrapper.testConfig.onRelease = onRelease;

      wrapper.testParseSpawnReleaseCommands('->relay:release Worker');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onRelease).toHaveBeenCalledWith('Worker');
    });
  });

  describe('continuity integration', () => {
    it('initializes agent ID on start', async () => {
      await wrapper.start();

      expect(wrapper.testAgentId).toBeDefined();
      expect(wrapper.testAgentId).toContain('test-agent-id');
    });

    it('resumes from previous agent ID if provided', async () => {
      // Pre-populate a ledger
      mockContinuityManager.ledgers.set('OldAgent', {
        agentName: 'OldAgent',
        agentId: 'resume-agent-id',
        cli: 'claude',
      });

      wrapper.testConfig.resumeAgentId = 'resume-agent-id';
      await wrapper.start();

      expect(wrapper.testAgentId).toBe('resume-agent-id');
    });

    it('saves summary to ledger', async () => {
      await wrapper.testSaveSummaryToLedger({
        currentTask: 'Implementing auth',
        completedTasks: ['Login', 'Logout'],
        context: 'Working on session handling',
        files: ['src/auth.ts'],
      });

      expect(mockContinuityManager.savedSummaries).toHaveLength(1);
      expect(mockContinuityManager.savedSummaries[0].updates.currentTask).toBe('Implementing auth');
      expect(mockContinuityManager.savedSummaries[0].updates.completed).toEqual(['Login', 'Logout']);
    });

    it('does not save empty summary', async () => {
      await wrapper.testSaveSummaryToLedger({});

      expect(mockContinuityManager.savedSummaries).toHaveLength(0);
    });

    it('resets session state', () => {
      wrapper.testSessionEndProcessed = true;
      wrapper.testLastSummaryRawContent = 'some content';
      wrapper.testSessionEndData = { summary: 'test' };

      wrapper.resetSessionState();

      expect(wrapper.testSessionEndProcessed).toBe(false);
      expect(wrapper.testLastSummaryRawContent).toBe('');
      expect(wrapper.testSessionEndData).toBeUndefined();
    });

    it('returns agent ID via getter', async () => {
      await wrapper.start();

      expect(wrapper.getAgentId()).toBe(wrapper.testAgentId);
    });
  });

  describe('relay command handling', () => {
    it('sends relay commands to client', () => {
      wrapper.testSendRelayCommand({
        to: 'ReceiverAgent',
        body: 'Hello',
        thread: 'thread-1',
      });

      expect(wrapper.testClient.sentMessages).toHaveLength(1);
      expect(wrapper.testClient.sentMessages[0].to).toBe('ReceiverAgent');
      expect(wrapper.testClient.sentMessages[0].body).toBe('Hello');
    });

    it('deduplicates sent messages by hash', () => {
      wrapper.testSendRelayCommand({ to: 'ReceiverAgent', body: 'Hello' });
      wrapper.testSendRelayCommand({ to: 'ReceiverAgent', body: 'Hello' }); // Same

      expect(wrapper.testClient.sentMessages).toHaveLength(1);
    });

    it('allows different messages to same target', () => {
      wrapper.testSendRelayCommand({ to: 'ReceiverAgent', body: 'Hello' });
      wrapper.testSendRelayCommand({ to: 'ReceiverAgent', body: 'World' });

      expect(wrapper.testClient.sentMessages).toHaveLength(2);
    });

    it('does not send when client not ready', () => {
      wrapper.testClient.state = 'CONNECTING';

      wrapper.testSendRelayCommand({ to: 'ReceiverAgent', body: 'Hello' });

      expect(wrapper.testClient.sentMessages).toHaveLength(0);
    });
  });

  describe('joinContinuationLines', () => {
    it('joins indented continuation lines for relay commands', () => {
      const content = `->relay:Target <<<
  Line 1
  Line 2
>>>`;
      const result = wrapper.testJoinContinuationLines(content);

      expect(result).toContain('->relay:Target');
      expect(result).toContain('Line 1');
    });

    it('joins continuation lines for continuity commands', () => {
      const content = `->continuity:save <<<
  Current task: Auth
  Completed: Login
>>>`;
      const result = wrapper.testJoinContinuationLines(content);

      expect(result).toContain('->continuity:save');
      expect(result).toContain('Current task: Auth');
    });

    it('stops joining on empty line', () => {
      const content = `->relay:Target <<<
  Line 1

  Line 2
>>>`;
      const lines = wrapper.testJoinContinuationLines(content).split('\n');

      // Should have separate entries for lines after empty line
      expect(lines.length).toBeGreaterThan(2);
    });

    it('stops joining on new block/bullet', () => {
      const content = `->relay:Target <<<content>>>
- Next bullet point`;
      const result = wrapper.testJoinContinuationLines(content);

      // Bullet should be separate
      expect(result).toContain('- Next bullet point');
    });

    it('handles content without commands unchanged', () => {
      const content = 'Just regular text\nOn multiple lines';
      const result = wrapper.testJoinContinuationLines(content);

      expect(result).toBe(content);
    });
  });

  describe('state management', () => {
    it('tracks running state', async () => {
      expect(wrapper.isRunning).toBe(false);

      await wrapper.start();
      expect(wrapper.isRunning).toBe(true);

      wrapper.stop();
      expect(wrapper.isRunning).toBe(false);
    });

    it('maintains separate dedup sets', () => {
      wrapper.testHandleIncomingMessage('A', { body: 'msg', kind: 'message' }, 'id1');
      wrapper.testSendRelayCommand({ to: 'B', body: 'msg' });
      wrapper.testParseSpawnReleaseCommands('->relay:spawn W claude "t"');

      expect(wrapper.testReceivedMessageIds.size).toBe(1);
      expect(wrapper.testSentMessageHashes.size).toBe(1);
      expect(wrapper.testProcessedSpawnCommands.size).toBe(1);
    });
  });
});
