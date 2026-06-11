import { describe, expect, it } from 'vitest';

import { GET as getLlmTxt } from '../../app/llm.txt/route';
import { GET as getLlmsTxt } from '../../app/llms.txt/route';
import { getDocMarkdown, getLlmsFullText, getLlmsText } from '../docs-markdown';

describe('docs markdown export for MDX components', () => {
  it('renders cards and banner links without leaking JSX', () => {
    const doc = getDocMarkdown('introduction');

    expect(doc).not.toBeNull();
    expect(doc?.markdown).not.toContain('<Card');
    expect(doc?.markdown).not.toContain('<CardGroup');
    expect(doc?.markdown).not.toContain('<BannerLink');
    expect(doc?.markdown).toContain('[Messaging](https://agentrelay.com/docs/messaging)');
    expect(doc?.markdown).toContain('[Delivery](https://agentrelay.com/docs/delivery)');
    expect(doc?.markdown).toContain('[Actions](https://agentrelay.com/docs/actions)');
    expect(doc?.markdown).toContain(
      '[Start with a workspace, messaging, delivery, and a Zod-backed action.](https://agentrelay.com/docs/quickstart)'
    );
  });

  it('builds a standards-style llms.txt index', () => {
    const llms = getLlmsText();

    expect(llms).toContain('# Agent Relay');
    expect(llms).toContain('https://agentrelay.com/llms-full.txt');
    expect(llms).toContain('https://agentrelay.com/docs/markdown/quickstart.md');
    expect(llms).not.toContain('https://agentrelay.com/docs/7.1.1/introduction');
  });

  it('serves the singular and plural llms paths as the same content', async () => {
    await expect(getLlmTxt().text()).resolves.toBe(await getLlmsTxt().text());
  });

  it('builds a full docs bundle from current docs', () => {
    const full = getLlmsFullText();

    expect(full).toContain('# Agent Relay Full Documentation');
    expect(full).toContain('## Documentation');
    expect(full).not.toContain('## Archived Documentation: v7.1.1');
    expect(full).toContain('Markdown endpoint: https://agentrelay.com/docs/markdown/quickstart.md');
    expect(full).not.toContain('Rendered page: https://agentrelay.com/docs/7.1.1/introduction');
    expect(full).not.toContain('<Card');
    expect(full).not.toContain('<Note');
    expect(full).not.toContain('<Warning');
    expect(full).not.toContain('<SpawnOptionsTable');
  });
});
