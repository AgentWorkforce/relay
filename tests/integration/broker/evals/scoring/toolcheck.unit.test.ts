import { describe, expect, it } from 'vitest';

import { checkToolNames, extractToolRefs, parseToolRef } from './toolcheck.js';

describe('parseToolRef', () => {
  it('splits prefix and name', () => {
    expect(parseToolRef('mcp__agent-relay__send_dm')).toEqual({
      raw: 'mcp__agent-relay__send_dm',
      prefix: 'agent-relay',
      name: 'send_dm',
    });
  });
  it('rejects non-tool strings', () => {
    expect(parseToolRef('send_dm')).toBeNull();
  });
});

describe('extractToolRefs', () => {
  it('pulls all references from text', () => {
    const text = 'Use mcp__agent-relay__send_dm or mcp__relaycast__message_post here.';
    expect(extractToolRefs(text)).toEqual(['mcp__agent-relay__send_dm', 'mcp__relaycast__message_post']);
  });
});

describe('checkToolNames', () => {
  const registered = ['send_dm', 'post_message', 'check_inbox'];

  it('passes when every reference maps to a registered tool', () => {
    const r = checkToolNames(registered, ['mcp__agent-relay__send_dm', 'mcp__agent-relay__post_message']);
    expect(r.ok).toBe(true);
    expect(r.mismatches).toHaveLength(0);
  });

  it('flags the wrong server prefix (the real skill bug)', () => {
    const r = checkToolNames(registered, ['mcp__relaycast__message_dm_send']);
    expect(r.ok).toBe(false);
    expect(r.mismatches[0].reason).toMatch(/wrong server prefix/);
  });

  it('flags a correct prefix but unregistered action name', () => {
    const r = checkToolNames(registered, ['mcp__agent-relay__message_dm_send']);
    expect(r.ok).toBe(false);
    expect(r.mismatches[0].reason).toMatch(/no such tool/);
  });

  it('dedupes repeated references', () => {
    const r = checkToolNames(registered, ['mcp__agent-relay__send_dm', 'mcp__agent-relay__send_dm']);
    expect(r.referenced).toHaveLength(1);
  });
});
