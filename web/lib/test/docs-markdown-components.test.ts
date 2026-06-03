import { describe, expect, it } from 'vitest';

import { getDocMarkdown } from '../docs-markdown';

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
});
