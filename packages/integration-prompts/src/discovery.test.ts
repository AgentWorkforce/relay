import { describe, expect, it } from 'vitest';
import { deriveDescriptorsFromMount, parseWritableResources } from './discovery.js';

const slackAdapterDoc = `# Slack adapter

The Slack adapter exposes channels and messages.

Resources:

| Resource | Schema | Create example | ID pattern | What it does |
|---|---|---|---|---|
| \`/slack/channels/{channelId}/messages/<id>.json\` | \`/slack/channels/{channelId}/messages/.schema.json\` | \`/slack/channels/{channelId}/messages/.create.example.json\` | \`.*\` | Posts a top-level Slack message. |
| \`/slack/channels/{channelId}/messages/{messageTs}/replies/<id>.json\` | \`/slack/channels/{channelId}/messages/{messageTs}/replies/.schema.json\` | \`/slack/channels/{channelId}/messages/{messageTs}/replies/.create.example.json\` | \`.*\` | Posts a reply in a Slack thread. |
`;

describe('parseWritableResources', () => {
  it('extracts resource rows from relayfile adapter markdown', () => {
    expect(parseWritableResources(slackAdapterDoc)).toEqual([
      {
        path: '/slack/channels/{channelId}/messages',
        schemaPath: '/slack/channels/{channelId}/messages/.schema.json',
        createExamplePath: '/slack/channels/{channelId}/messages/.create.example.json',
        description: 'Posts a top-level Slack message.',
        name: 'messages',
      },
      {
        path: '/slack/channels/{channelId}/messages/{messageTs}/replies',
        schemaPath: '/slack/channels/{channelId}/messages/{messageTs}/replies/.schema.json',
        createExamplePath: '/slack/channels/{channelId}/messages/{messageTs}/replies/.create.example.json',
        description: 'Posts a reply in a Slack thread.',
        name: 'replies',
      },
    ]);
  });
});

describe('deriveDescriptorsFromMount', () => {
  it('uses listTree/listPaths to discover providers and adapter docs', async () => {
    const files = new Map([['.integrations/discovery/slack/.adapter.md', slackAdapterDoc]]);

    const descriptors = await deriveDescriptorsFromMount({
      readFile: (path) => files.get(path),
      listTree: () => ['.integrations/discovery/slack/.adapter.md'],
    });

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.provider).toBe('slack');
    expect(descriptors[0]?.mountRoot).toBe('.integrations/slack');
    expect(descriptors[0]?.writableResources.map((resource) => resource.path)).toEqual([
      '/slack/channels/{channelId}/messages',
      '/slack/channels/{channelId}/messages/{messageTs}/replies',
    ]);
  });

  it('skips missing providers without throwing', async () => {
    await expect(deriveDescriptorsFromMount(() => undefined, { knownProviders: ['slack'] })).resolves.toEqual(
      []
    );
  });
});
