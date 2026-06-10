import { describe, expect, it } from 'vitest';

import { getLlmsText } from '../docs-markdown';

describe('llms.txt index', () => {
  it('follows the llmstxt.org shape and links the markdown mirrors', () => {
    const txt = getLlmsText();

    expect(txt.startsWith('# Agent Relay\n')).toBe(true);
    expect(txt).toContain('\n> Agent Relay is Headless Slack for agents');
    expect(txt).toContain('## Documentation');
    expect(txt).toContain('(https://agentrelay.com/llms-full.txt)');
    expect(txt).toContain('(https://agentrelay.com/docs/markdown/typescript-sdk.md)');
    expect(txt).toContain('(https://agentrelay.com/docs/markdown/quickstart.md)');
  });
});
