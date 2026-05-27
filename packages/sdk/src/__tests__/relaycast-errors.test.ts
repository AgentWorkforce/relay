import { describe, expect, it } from 'vitest';

import {
  INVALID_AGENT_TOKEN_CODE,
  INVALID_AGENT_TOKEN_MESSAGE,
  agentTokenRecoveryMessage,
  isInvalidAgentTokenError,
  isInvalidAgentTokenToolResult,
} from '../relaycast-errors.js';

describe('isInvalidAgentTokenError', () => {
  it('matches by typed code on the error object itself', () => {
    const err = Object.assign(new Error('whatever'), { code: INVALID_AGENT_TOKEN_CODE });
    expect(isInvalidAgentTokenError(err)).toBe(true);
  });

  it('matches the typed code regardless of case or surrounding whitespace', () => {
    const err = Object.assign(new Error(), { code: ' AGENT_TOKEN_INVALID ' });
    expect(isInvalidAgentTokenError(err)).toBe(true);
  });

  it('matches the legacy 401 + canonical message pair', () => {
    const err = Object.assign(new Error(INVALID_AGENT_TOKEN_MESSAGE), { statusCode: 401 });
    expect(isInvalidAgentTokenError(err)).toBe(true);
  });

  it('accepts `status` as an alternate name for `statusCode`', () => {
    const err = Object.assign(new Error(INVALID_AGENT_TOKEN_MESSAGE), { status: 401 });
    expect(isInvalidAgentTokenError(err)).toBe(true);
  });

  it('walks into a `body.error` envelope when the code lives there', () => {
    const err = Object.assign(new Error('Unauthorized'), {
      status: 401,
      body: { error: { code: INVALID_AGENT_TOKEN_CODE, message: 'irrelevant' } },
    });
    expect(isInvalidAgentTokenError(err)).toBe(true);
  });

  it('walks into nested `cause` chains', () => {
    const inner = Object.assign(new Error(INVALID_AGENT_TOKEN_MESSAGE), { statusCode: 401 });
    const outer = Object.assign(new Error('upstream call failed'), { cause: inner });
    expect(isInvalidAgentTokenError(outer)).toBe(true);
  });

  it('ignores 401s that are not the agent token contract', () => {
    const err = Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    expect(isInvalidAgentTokenError(err)).toBe(false);
  });

  it('returns false for non-object inputs', () => {
    expect(isInvalidAgentTokenError(null)).toBe(false);
    expect(isInvalidAgentTokenError(undefined)).toBe(false);
    expect(isInvalidAgentTokenError('Invalid agent token')).toBe(false);
  });
});

describe('isInvalidAgentTokenToolResult', () => {
  it('detects the canonical message anywhere in the content array', () => {
    const result = {
      content: [
        { type: 'text', text: 'noise' },
        { type: 'text', text: INVALID_AGENT_TOKEN_MESSAGE },
      ],
    };
    expect(isInvalidAgentTokenToolResult(result)).toBe(true);
  });

  it('ignores results whose content does not include the marker', () => {
    expect(
      isInvalidAgentTokenToolResult({
        content: [{ type: 'text', text: 'all good' }],
      })
    ).toBe(false);
  });

  it('ignores results without a content array', () => {
    expect(isInvalidAgentTokenToolResult({})).toBe(false);
    expect(isInvalidAgentTokenToolResult(null)).toBe(false);
  });
});

describe('agentTokenRecoveryMessage', () => {
  it('embeds the typed code and references the register_agent tool', () => {
    const msg = agentTokenRecoveryMessage();
    expect(msg).toContain(INVALID_AGENT_TOKEN_CODE);
    expect(msg).toContain('register_agent');
  });
});
