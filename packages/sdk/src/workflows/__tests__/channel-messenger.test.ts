import { describe, expect, it, vi } from 'vitest';

// Import from the module that will be extracted from runner.ts
import {
  ChannelMessenger,
  formatError,
  formatStepOutput,
  sendToChannel,
  truncateMessage,
} from '../channel-messenger.js';

describe('channel messenger helpers', () => {
  it('sendToChannel forwards messages to the relay client', async () => {
    const relay = { send: vi.fn().mockResolvedValue(undefined) };
    await sendToChannel(relay, 'workflow-room', 'hello');
    expect(relay.send).toHaveBeenCalledWith('workflow-room', 'hello');
  });

  it('truncateMessage keeps the most recent tail within the limit', () => {
    expect(truncateMessage('abcdefghij', 4)).toBe('ghij');
    expect(truncateMessage('abc', 10)).toBe('abc');
  });

  it('formatStepOutput returns a completion note when scrubbed output is empty', () => {
    expect(formatStepOutput('plan', '▗▖\n')).toBe('**[plan]** Step completed — output written to disk');
  });

  it('formatStepOutput scrubs noise and formats a fenced block', () => {
    const output = 'Thinking…\nuseful line\n';
    expect(formatStepOutput('plan', output)).toBe('**[plan] Output:**\n```\nuseful line\n```');
  });

  it('formatError normalizes unknown errors', () => {
    expect(formatError('build', new Error('Boom'))).toBe('**[build]** Failed: Boom');
    expect(formatError('build', 'bad input')).toBe('**[build]** Failed: bad input');
  });
});

describe('ChannelMessenger', () => {
  describe('buildNonInteractiveAwareness', () => {
    it('returns undefined when no non-interactive agents exist', () => {
      const messenger = new ChannelMessenger();
      const agents = new Map([['worker', { name: 'worker', cli: 'claude', interactive: true }]]);
      const result = messenger.buildNonInteractiveAwareness(agents as any, new Map());
      expect(result).toBeUndefined();
    });

    it('lists non-interactive agents with step references', () => {
      const messenger = new ChannelMessenger();
      const agents = new Map([
        ['bg-worker', { name: 'bg-worker', cli: 'claude', interactive: false }],
      ]);
      const stepStates = new Map([
        ['analyze', { row: { agentName: 'bg-worker', status: 'running' } }],
      ]);
      const result = messenger.buildNonInteractiveAwareness(agents as any, stepStates as any);
      expect(result).toContain('bg-worker');
      expect(result).toContain('{{steps.analyze.output}}');
      expect(result).toContain('cannot receive messages');
    });
  });

  describe('buildDelegationGuidance', () => {
    it('includes timeout note when timeout is provided', () => {
      const messenger = new ChannelMessenger();
      const result = messenger.buildDelegationGuidance('claude', 300_000);
      expect(result).toContain('5 minutes');
      expect(result).toContain('AUTONOMOUS DELEGATION');
    });

    it('includes sub-agent option only for claude CLI', () => {
      const messenger = new ChannelMessenger();
      const claudeResult = messenger.buildDelegationGuidance('claude');
      const codexResult = messenger.buildDelegationGuidance('codex');
      expect(claudeResult).toContain('Task tool');
      expect(codexResult).not.toContain('Task tool');
    });

    it('omits timeout note when no timeout given', () => {
      const messenger = new ChannelMessenger();
      const result = messenger.buildDelegationGuidance('claude');
      expect(result).not.toContain('minutes before this step');
    });
  });

  describe('buildRelayRegistrationNote', () => {
    it('returns empty string for claude CLI', () => {
      const messenger = new ChannelMessenger();
      expect(messenger.buildRelayRegistrationNote('claude', 'worker-1')).toBe('');
    });

    it('returns registration instructions for non-claude CLIs', () => {
      const messenger = new ChannelMessenger();
      const result = messenger.buildRelayRegistrationNote('codex', 'helper-1');
      expect(result).toContain('register(name="helper-1")');
      expect(result).toContain('RELAY SETUP');
    });
  });

  describe('postCompletionReport', () => {
    it('formats a completion report with step results', () => {
      const postSpy = vi.fn();
      const messenger = new ChannelMessenger({ postFn: postSpy });
      const outcomes = [
        { name: 'plan', agent: 'lead', status: 'completed', attempts: 1, verificationPassed: true },
        { name: 'code', agent: 'worker', status: 'completed', attempts: 2 },
        { name: 'optional', agent: 'worker', status: 'skipped', attempts: 0 },
      ];
      messenger.postCompletionReport('my-workflow', outcomes as any, 'All done', 0.95);
      expect(postSpy).toHaveBeenCalledTimes(1);
      const text = postSpy.mock.calls[0][0];
      expect(text).toContain('my-workflow');
      expect(text).toContain('Complete');
      expect(text).toContain('95%');
      expect(text).toContain('verified');
      expect(text).toContain('2 attempts');
      expect(text).toContain('skipped');
    });
  });

  describe('postFailureReport', () => {
    it('formats a failure report with error details', () => {
      const postSpy = vi.fn();
      const messenger = new ChannelMessenger({ postFn: postSpy });
      const outcomes = [
        { name: 'plan', agent: 'lead', status: 'completed', attempts: 1 },
        { name: 'code', agent: 'worker', status: 'failed', attempts: 3, error: 'Timeout exceeded' },
      ];
      messenger.postFailureReport('my-workflow', outcomes as any, 'Step failed');
      expect(postSpy).toHaveBeenCalledTimes(1);
      const text = postSpy.mock.calls[0][0];
      expect(text).toContain('Failed');
      expect(text).toContain('1/2 steps passed');
      expect(text).toContain('Timeout exceeded');
    });
  });
});
