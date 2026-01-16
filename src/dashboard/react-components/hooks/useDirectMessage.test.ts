/**
 * Tests for useDirectMessage hook - DM filtering and deduplication logic
 *
 * TDD approach: Write failing tests first, then fix the implementation.
 */

import { describe, it, expect } from 'vitest';
import type { Agent, Message } from '../../types';

// Replicate the filtering and deduplication logic from useDirectMessage hook
// to test in isolation without React

interface DirectMessageTestContext {
  currentHuman: Agent | null;
  currentUserName: string | null;
  messages: Message[];
  agents: Agent[];
  selectedDmAgents: string[];
  removedDmAgents: string[];
}

function computeDmParticipantAgents(ctx: DirectMessageTestContext): string[] {
  const { currentHuman, messages, agents, selectedDmAgents, removedDmAgents } = ctx;
  if (!currentHuman) return [];

  const agentNameSet = new Set(agents.map((a) => a.name));
  const humanName = currentHuman.name;
  const derived = new Set<string>();

  for (const msg of messages) {
    const { from, to } = msg;
    if (!from || !to) continue;
    if (from === humanName && agentNameSet.has(to)) derived.add(to);
    if (to === humanName && agentNameSet.has(from)) derived.add(from);
    if (selectedDmAgents.includes(from) && agentNameSet.has(to)) derived.add(to);
    if (selectedDmAgents.includes(to) && agentNameSet.has(from)) derived.add(from);
  }

  const participants = new Set<string>([...selectedDmAgents, ...derived]);
  removedDmAgents.forEach((a) => participants.delete(a));
  return Array.from(participants);
}

function filterVisibleMessages(ctx: DirectMessageTestContext): Message[] {
  const { currentHuman, currentUserName, messages } = ctx;
  if (!currentHuman) return messages;

  const dmParticipantAgents = computeDmParticipantAgents(ctx);
  const participants = new Set<string>([currentHuman.name, ...dmParticipantAgents]);
  // Add current user to participants - use "Dashboard" as fallback for local mode
  const effectiveUserName = currentUserName || 'Dashboard';
  participants.add(effectiveUserName);

  return messages.filter((msg) => {
    if (!msg.from || !msg.to) return false;
    return participants.has(msg.from) && participants.has(msg.to);
  });
}

// Helper to create test messages
function createMessage(from: string, to: string, content: string, id?: string): Message {
  return {
    id: id || `msg-${Math.random().toString(36).slice(2)}`,
    from,
    to,
    content,
    timestamp: new Date().toISOString(),
  };
}

// Helper to create test agents
function createAgent(name: string, isHuman = false): Agent {
  return {
    name,
    status: 'online',
    isHuman,
  };
}

describe('useDirectMessage', () => {
  describe('basic DM filtering', () => {
    it('should show messages between current user and human in 1:1 DM', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'Hi Alice!'),
          createMessage('alice', 'bob', 'Hi Bob!'),
        ],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);
      expect(visible).toHaveLength(2);
    });

    it('should filter out messages not involving DM participants', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'Hi Alice!'),
          createMessage('charlie', 'dave', 'Unrelated message'),
        ],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);
      expect(visible).toHaveLength(1);
      expect(visible[0].content).toBe('Hi Alice!');
    });
  });

  describe('group DM with agents', () => {
    it('should show messages when agent is invited to DM', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'Hi Alice!'),
          createMessage('bob', 'Agent1', 'Hi Agent1!'),
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);
      // Both messages should be visible since Agent1 is invited
      expect(visible).toHaveLength(2);
    });

    /**
     * THE BUG: Agent response should appear in group DM
     *
     * Scenario:
     * - Bob is viewing a DM with Alice
     * - Bob invites Agent1 to the conversation
     * - Bob sends a message (goes to both Alice and Agent1)
     * - Agent1 responds TO BOB
     *
     * Expected: Agent1's response should appear in the group DM view
     * Actual: Agent1's response may be filtered out or appear in wrong place
     */
    it('should show agent response in group DM when agent responds to sender', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'Hi Alice!'),
          createMessage('bob', 'Agent1', 'Agent1, help us please'),
          createMessage('Agent1', 'bob', 'Sure, I can help!'), // Agent responds to Bob
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // All three messages should be visible:
      // 1. bob -> alice
      // 2. bob -> Agent1
      // 3. Agent1 -> bob (THIS IS THE KEY TEST)
      expect(visible).toHaveLength(3);
      expect(visible.map(m => m.content)).toContain('Sure, I can help!');
    });

    it('should show agent response when agent responds to human (not current user)', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'Hi Alice!'),
          createMessage('bob', 'Agent1', 'Agent1, help Alice'),
          createMessage('Agent1', 'alice', 'Hi Alice, I am here to help'), // Agent responds to Alice
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // All three messages should be visible
      expect(visible).toHaveLength(3);
      expect(visible.map(m => m.content)).toContain('Hi Alice, I am here to help');
    });

    it('should handle multiple agents in group DM', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'Group meeting'),
          createMessage('bob', 'Agent1', 'Agent1 invited'),
          createMessage('bob', 'Agent2', 'Agent2 invited'),
          createMessage('Agent1', 'bob', 'Agent1 here'),
          createMessage('Agent2', 'bob', 'Agent2 here'),
          createMessage('Agent1', 'Agent2', 'Agent-to-agent chat'), // Agents talking to each other
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2')],
        selectedDmAgents: ['Agent1', 'Agent2'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // All 6 messages should be visible since all participants are in the group
      expect(visible).toHaveLength(6);
    });

    it('should NOT show agent messages if agent is removed from DM', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'Hi Alice!'),
          createMessage('Agent1', 'bob', 'Message from removed agent'),
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: [],
        removedDmAgents: ['Agent1'], // Agent was removed
      };

      const visible = filterVisibleMessages(ctx);

      // Only bob->alice should be visible, agent message filtered out
      expect(visible).toHaveLength(1);
      expect(visible[0].content).toBe('Hi Alice!');
    });
  });

  describe('participant derivation from message history', () => {
    it('should derive agent as participant if human messaged agent', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('alice', 'Agent1', 'Alice messaged agent directly'),
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: [], // Not explicitly selected
        removedDmAgents: [],
      };

      const participants = computeDmParticipantAgents(ctx);

      // Agent1 should be derived as participant because alice messaged it
      expect(participants).toContain('Agent1');
    });

    it('should derive agent as participant if agent messaged human', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('Agent1', 'alice', 'Agent proactively messaged Alice'),
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const participants = computeDmParticipantAgents(ctx);

      expect(participants).toContain('Agent1');
    });

    it('should NOT derive agent if it was removed', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('alice', 'Agent1', 'Before removal'),
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: [],
        removedDmAgents: ['Agent1'], // Explicitly removed
      };

      const participants = computeDmParticipantAgents(ctx);

      expect(participants).not.toContain('Agent1');
    });
  });

  describe('edge cases - currentUserName scenarios', () => {
    /**
     * CRITICAL BUG TEST: When currentUserName is null (local mode),
     * the current user is not added to participants, causing agent
     * responses to the current user to be filtered out!
     */
    it('BUG: should show agent response even when currentUserName is null', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: null, // Local mode - no cloud auth
        messages: [
          // Dashboard sends as "Dashboard" in local mode
          createMessage('Dashboard', 'alice', 'Hi Alice!'),
          createMessage('Dashboard', 'Agent1', 'Agent1, help us'),
          createMessage('Agent1', 'Dashboard', 'Sure, I can help!'), // Agent responds to Dashboard
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // BUG: This will likely fail because "Dashboard" is not in participants
      // when currentUserName is null
      expect(visible).toHaveLength(3);
      expect(visible.map(m => m.content)).toContain('Sure, I can help!');
    });

    it('should handle "Dashboard" as sender when no currentUserName', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: null,
        messages: [
          createMessage('Dashboard', 'alice', 'Message from local mode'),
        ],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // In local mode, Dashboard should still be able to send to humans
      // But the filter requires BOTH from and to to be in participants
      // participants = {alice} only when currentUserName is null
      // So "Dashboard" is not in participants!
      expect(visible).toHaveLength(1); // This might fail!
    });
  });

  describe('edge cases', () => {
    it('should handle empty messages array', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);
      expect(visible).toHaveLength(0);
    });

    it('should handle null currentHuman', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: null,
        currentUserName: 'bob',
        messages: [createMessage('bob', 'alice', 'Test')],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);
      // Should return all messages when not in DM mode
      expect(visible).toHaveLength(1);
    });

    it('should handle messages with missing from/to', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          { id: '1', content: 'No from', to: 'alice', timestamp: new Date().toISOString() } as Message,
          { id: '2', content: 'No to', from: 'bob', timestamp: new Date().toISOString() } as Message,
          createMessage('bob', 'alice', 'Valid message'),
        ],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);
      // Only valid message should be included
      expect(visible).toHaveLength(1);
      expect(visible[0].content).toBe('Valid message');
    });

    it('should be case-sensitive for participant matching', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('Alice', true), // Capital A
        currentUserName: 'Bob', // Capital B
        messages: [
          createMessage('Bob', 'Alice', 'Correct case'),
          createMessage('bob', 'alice', 'Wrong case'), // lowercase - should NOT match
        ],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);
      // Only correctly-cased message should appear
      // (Note: This may need to be case-insensitive depending on requirements)
      expect(visible).toHaveLength(1);
      expect(visible[0].content).toBe('Correct case');
    });
  });

  describe('advanced agent derivation', () => {
    it('should derive second agent when selected agent messages another agent', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('Agent1', 'Agent2', 'Agent1 talking to Agent2'),
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2')],
        selectedDmAgents: ['Agent1'], // Only Agent1 explicitly selected
        removedDmAgents: [],
      };

      const participants = computeDmParticipantAgents(ctx);

      // Agent2 should be derived because Agent1 (selected) messaged it
      expect(participants).toContain('Agent1');
      expect(participants).toContain('Agent2');
    });

    it('should derive agent chain: agent1 → agent2 → agent3', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('alice', 'Agent1', 'Alice starts with Agent1'),
          createMessage('Agent1', 'Agent2', 'Agent1 brings in Agent2'),
          // Note: Agent2 -> Agent3 won't derive Agent3 because Agent2 wasn't in selectedDmAgents
          // This tests the current behavior - derivation only goes one level deep from selected agents
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2'), createAgent('Agent3')],
        selectedDmAgents: [], // No explicit selection, relying on derivation
        removedDmAgents: [],
      };

      const participants = computeDmParticipantAgents(ctx);

      // Agent1 derived from alice -> Agent1
      expect(participants).toContain('Agent1');
      // Agent2 NOT derived because Agent1 wasn't in selectedDmAgents
      // (derivation requires explicit selection or human involvement)
      expect(participants).not.toContain('Agent2');
    });

    it('should derive agents from both human and selected agent interactions', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('alice', 'Agent1', 'Alice to Agent1'),
          createMessage('Agent1', 'Agent2', 'Agent1 to Agent2'),
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2')],
        selectedDmAgents: ['Agent1'], // Agent1 explicitly selected
        removedDmAgents: [],
      };

      const participants = computeDmParticipantAgents(ctx);

      // Both should be derived
      expect(participants).toContain('Agent1'); // From alice -> Agent1 AND selectedDmAgents
      expect(participants).toContain('Agent2'); // From Agent1 (selected) -> Agent2
    });
  });

  describe('complex removal scenarios', () => {
    it('should handle removing one agent from multiple agents', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'Agent1', 'To Agent1'),
          createMessage('bob', 'Agent2', 'To Agent2'),
          createMessage('bob', 'Agent3', 'To Agent3'),
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2'), createAgent('Agent3')],
        selectedDmAgents: ['Agent1', 'Agent2', 'Agent3'],
        removedDmAgents: ['Agent2'], // Only Agent2 removed
      };

      const participants = computeDmParticipantAgents(ctx);

      expect(participants).toContain('Agent1');
      expect(participants).not.toContain('Agent2');
      expect(participants).toContain('Agent3');
    });

    it('should filter messages involving removed agent', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'To Alice'),
          createMessage('bob', 'Agent1', 'To Agent1'),
          createMessage('Agent1', 'bob', 'From Agent1'),
          createMessage('bob', 'Agent2', 'To removed Agent2'),
          createMessage('Agent2', 'bob', 'From removed Agent2'),
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2')],
        selectedDmAgents: ['Agent1', 'Agent2'],
        removedDmAgents: ['Agent2'],
      };

      const visible = filterVisibleMessages(ctx);

      // Should see: bob->alice, bob->Agent1, Agent1->bob
      // Should NOT see: bob->Agent2, Agent2->bob
      expect(visible).toHaveLength(3);
      expect(visible.map(m => m.content)).not.toContain('To removed Agent2');
      expect(visible.map(m => m.content)).not.toContain('From removed Agent2');
    });

    it('should handle re-adding agent after removal via selection', () => {
      // Scenario: Agent was removed but is now back in selectedDmAgents
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('Agent1', 'bob', 'Agent1 message'),
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'], // Re-added via selection
        removedDmAgents: [], // No longer in removed list
      };

      const participants = computeDmParticipantAgents(ctx);
      const visible = filterVisibleMessages(ctx);

      expect(participants).toContain('Agent1');
      expect(visible).toHaveLength(1);
    });
  });

  describe('agent-to-agent communication', () => {
    it('should show agent-to-agent messages when both are participants', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('Agent1', 'Agent2', 'Collaboration message'),
          createMessage('Agent2', 'Agent1', 'Response'),
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2')],
        selectedDmAgents: ['Agent1', 'Agent2'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      expect(visible).toHaveLength(2);
    });

    it('should derive Agent2 when Agent1 (selected) messages it', () => {
      // This tests that derivation works: when a selected agent messages another agent,
      // the recipient agent becomes a derived participant
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('Agent1', 'Agent2', 'Message triggers derivation'),
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2')],
        selectedDmAgents: ['Agent1'], // Only Agent1 is selected
        removedDmAgents: [],
      };

      const participants = computeDmParticipantAgents(ctx);
      const visible = filterVisibleMessages(ctx);

      // Agent2 gets derived because Agent1 (selected) messaged it
      expect(participants).toContain('Agent2');
      expect(visible).toHaveLength(1);
    });

    it('should NOT show message from non-participant to non-participant', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('Agent3', 'Agent4', 'Neither agent is a participant'),
        ],
        agents: [createAgent('Agent1'), createAgent('Agent3'), createAgent('Agent4')],
        selectedDmAgents: ['Agent1'], // Only Agent1 is selected, not Agent3 or Agent4
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // Neither Agent3 nor Agent4 are participants, so message is filtered
      expect(visible).toHaveLength(0);
    });
  });

  describe('human participant scenarios', () => {
    it('should show human (currentHuman) initiating conversation with agent', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('alice', 'Agent1', 'Alice starts the conversation'),
          createMessage('Agent1', 'alice', 'Agent1 responds to Alice'),
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      expect(visible).toHaveLength(2);
    });

    it('should show messages from human to current user', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('alice', 'bob', 'Alice messages Bob directly'),
          createMessage('bob', 'alice', 'Bob responds'),
        ],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      expect(visible).toHaveLength(2);
    });
  });

  describe('cloud mode scenarios', () => {
    it('should work with GitHub username as currentUserName', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'github-user-1', // GitHub username (generic)
        messages: [
          createMessage('github-user-1', 'alice', 'Hi from GitHub user'),
          createMessage('alice', 'github-user-1', 'Hi back!'),
          createMessage('github-user-1', 'Agent1', 'Agent help'),
          createMessage('Agent1', 'github-user-1', 'Agent response'),
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      expect(visible).toHaveLength(4);
    });

    it('should handle mixed Dashboard and username messages', () => {
      // Edge case: what if both Dashboard and username appear in messages?
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob', // Cloud mode with username
        messages: [
          createMessage('Dashboard', 'alice', 'Old local mode message'),
          createMessage('bob', 'alice', 'New cloud mode message'),
        ],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // Only bob->alice should show (Dashboard is not bob)
      // This tests that we correctly use currentUserName when provided
      expect(visible).toHaveLength(1);
      expect(visible[0].content).toBe('New cloud mode message');
    });

    // CLOUD MODE SPECIFIC TESTS - currentUserName is NEVER null in cloud
    it('CLOUD: should route agent responses correctly with GitHub username', () => {
      // This is the original bug scenario but in cloud mode
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'github-user-1', // Cloud mode - always has username
        messages: [
          createMessage('github-user-1', 'alice', 'Hi Alice!'),
          createMessage('github-user-1', 'Agent1', 'Agent1, help us please'),
          createMessage('Agent1', 'github-user-1', 'Sure, I can help!'), // Agent responds to user
        ],
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // All messages should be visible - agent response stays in group DM
      expect(visible).toHaveLength(3);
      expect(visible.map(m => m.content)).toContain('Sure, I can help!');
    });

    it('CLOUD: should handle multiple agents with GitHub username', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'github-user-2', // Different GitHub user
        messages: [
          createMessage('github-user-2', 'alice', 'Team meeting'),
          createMessage('github-user-2', 'Frontend', 'Frontend agent invited'),
          createMessage('github-user-2', 'Backend', 'Backend agent invited'),
          createMessage('Frontend', 'github-user-2', 'Frontend here'),
          createMessage('Backend', 'github-user-2', 'Backend here'),
          createMessage('Frontend', 'Backend', 'Agent collaboration'),
        ],
        agents: [createAgent('Frontend'), createAgent('Backend')],
        selectedDmAgents: ['Frontend', 'Backend'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // All 6 messages visible
      expect(visible).toHaveLength(6);
    });

    it('CLOUD: currentUserName is never null - Dashboard fallback not used', () => {
      // Verify that when username is provided, "Dashboard" is NOT in participants
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'github-user-1', // Cloud mode
        messages: [
          createMessage('Dashboard', 'alice', 'This should NOT appear'),
          createMessage('github-user-1', 'alice', 'This should appear'),
        ],
        agents: [],
        selectedDmAgents: [],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // Dashboard message filtered out - only github-user-1 messages shown
      expect(visible).toHaveLength(1);
      expect(visible[0].from).toBe('github-user-1');
    });

    it('CLOUD: agent removal works with GitHub username', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'github-user-1',
        messages: [
          createMessage('github-user-1', 'Agent1', 'To Agent1'),
          createMessage('Agent1', 'github-user-1', 'From Agent1'),
          createMessage('github-user-1', 'Agent2', 'To Agent2'),
          createMessage('Agent2', 'github-user-1', 'From Agent2'),
        ],
        agents: [createAgent('Agent1'), createAgent('Agent2')],
        selectedDmAgents: ['Agent1', 'Agent2'],
        removedDmAgents: ['Agent2'], // Agent2 removed
      };

      const visible = filterVisibleMessages(ctx);

      // Only Agent1 messages should be visible
      expect(visible).toHaveLength(2);
      expect(visible.every(m => m.from === 'Agent1' || m.to === 'Agent1')).toBe(true);
    });
  });

  describe('boundary conditions', () => {
    it('should handle many agents (5+)', () => {
      const agents = ['Agent1', 'Agent2', 'Agent3', 'Agent4', 'Agent5', 'Agent6'].map(
        name => createAgent(name)
      );
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: agents.map(a => createMessage('bob', a.name, `Message to ${a.name}`)),
        agents,
        selectedDmAgents: agents.map(a => a.name),
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      expect(visible).toHaveLength(6);
    });

    it('should handle conversation with many message exchanges', () => {
      const messages: Message[] = [];
      for (let i = 0; i < 50; i++) {
        messages.push(createMessage('bob', 'alice', `Message ${i}`));
        messages.push(createMessage('alice', 'bob', `Response ${i}`));
        messages.push(createMessage('bob', 'Agent1', `Agent message ${i}`));
        messages.push(createMessage('Agent1', 'bob', `Agent response ${i}`));
      }

      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages,
        agents: [createAgent('Agent1')],
        selectedDmAgents: ['Agent1'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      expect(visible).toHaveLength(200); // 50 * 4 messages
    });

    it('should handle agent with same prefix as human name', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true),
        currentUserName: 'bob',
        messages: [
          createMessage('bob', 'alice', 'To human alice'),
          createMessage('bob', 'alice-agent', 'To agent alice-agent'),
        ],
        agents: [createAgent('alice-agent')], // Agent name starts with human name
        selectedDmAgents: ['alice-agent'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      expect(visible).toHaveLength(2);
    });
  });

  describe('GitHub username vs _DashboardUI routing', () => {
    /**
     * BUG FIX TEST: Messages to GitHub username should be visible
     *
     * When an agent sends a message TO a user's GitHub username,
     * the message should appear in the user's DM view.
     *
     * Scenario:
     * - User "khaliqgant" is viewing DMs
     * - Lead agent sends message to "khaliqgant"
     * - Message should be visible to khaliqgant
     */
    it('should show messages sent TO user GitHub username', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('khaliqgant', true), // Viewing own DMs
        currentUserName: 'khaliqgant', // User's GitHub username
        messages: [
          createMessage('Lead', 'khaliqgant', 'Hello khaliqgant, here is an update'),
        ],
        agents: [createAgent('Lead')], // Lead is an AI agent
        selectedDmAgents: ['Lead'], // Lead was invited to conversation
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // Message from Lead to khaliqgant should be visible
      expect(visible).toHaveLength(1);
      expect(visible[0].content).toBe('Hello khaliqgant, here is an update');
    });

    /**
     * _DashboardUI messages should NOT appear in DM view
     *
     * _DashboardUI is a system client, not a real participant.
     * Messages addressed to _DashboardUI should not be shown.
     */
    it('should NOT show messages sent TO _DashboardUI', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('khaliqgant', true),
        currentUserName: 'khaliqgant',
        messages: [
          createMessage('Lead', '_DashboardUI', 'Message to system client'),
        ],
        agents: [createAgent('Lead')],
        selectedDmAgents: ['Lead'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // Message to _DashboardUI should NOT be visible (it's not a participant)
      expect(visible).toHaveLength(0);
    });

    /**
     * Both GitHub username AND _DashboardUI messages in same conversation
     *
     * When an agent sends to both targets, only the GitHub username
     * message should be visible.
     */
    it('should show GitHub username messages but not _DashboardUI messages', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('khaliqgant', true),
        currentUserName: 'khaliqgant',
        messages: [
          createMessage('Lead', 'khaliqgant', 'Direct to user'),
          createMessage('Lead', '_DashboardUI', 'To system client'),
          createMessage('khaliqgant', 'Lead', 'Reply from user'),
        ],
        agents: [createAgent('Lead')],
        selectedDmAgents: ['Lead'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // Only 2 messages visible (Lead->khaliqgant and khaliqgant->Lead)
      // Lead->_DashboardUI should be filtered out
      expect(visible).toHaveLength(2);
      expect(visible.map(m => m.to)).not.toContain('_DashboardUI');
    });

    /**
     * Edge case: currentUserName is different from currentHuman.name
     *
     * When viewing another user's DMs (e.g., admin view),
     * messages to currentUserName should still be filtered correctly.
     */
    it('should use effectiveUserName (currentUserName) for filtering, not currentHuman.name', () => {
      const ctx: DirectMessageTestContext = {
        currentHuman: createAgent('alice', true), // Viewing DMs with alice
        currentUserName: 'bob', // Current logged-in user is bob
        messages: [
          createMessage('Lead', 'bob', 'Message to bob (current user)'),
          createMessage('Lead', 'alice', 'Message to alice (DM partner)'),
          createMessage('Lead', 'charlie', 'Message to charlie (third party)'),
        ],
        agents: [createAgent('Lead')],
        selectedDmAgents: ['Lead'],
        removedDmAgents: [],
      };

      const visible = filterVisibleMessages(ctx);

      // Lead->bob and Lead->alice should be visible
      // Lead->charlie should NOT be visible
      expect(visible).toHaveLength(2);
      expect(visible.map(m => m.to)).toContain('bob');
      expect(visible.map(m => m.to)).toContain('alice');
      expect(visible.map(m => m.to)).not.toContain('charlie');
    });
  });
});
