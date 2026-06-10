import { describe, expect, it } from 'vitest';

import { getLlmsTxt } from '../docs-markdown';

describe('llms.txt index', () => {
  it('follows the llmstxt.org shape and links the markdown mirrors', () => {
    const txt = getLlmsTxt();

    expect(txt.startsWith('# Agent Relay\n')).toBe(true);
    expect(txt).toContain('\n> Headless Slack for agents');
    expect(txt).toContain('## Docs');
    expect(txt).toContain('(https://agentrelay.com/docs/markdown/typescript-sdk.md)');
    expect(txt).toContain('(https://agentrelay.com/docs/markdown/quickstart.md)');
    expect(txt).toContain('(https://agentrelay.com/llm.txt)');
  });
});
