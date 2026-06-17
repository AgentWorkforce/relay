import { describe, expect, it } from 'vitest';
import {
  fullInjectInstructions,
  initialSpawnInstructions,
  prescriptiveInstructions,
  slimInstructions,
} from './builders.js';
import type { IntegrationDescriptor } from './types.js';

const descriptors: IntegrationDescriptor[] = [
  {
    provider: 'slack',
    mountRoot: '.integrations/slack',
    discoveryRoot: '.integrations/discovery/slack',
    writableResources: [
      {
        path: '/slack/channels/{channelId}/messages',
        createExamplePath: '/slack/channels/{channelId}/messages/.create.example.json',
        description: 'Posts a top-level Slack message.',
      },
    ],
    scopeLabels: ['channel C123'],
    eventScopePaths: ['.integrations/slack/channels/C123/messages'],
    writebackPaths: ['.integrations/slack/channels/C123/messages'],
    liveContextPaths: ['.integrations/slack/channels/C123/threads'],
    subscriptions: [
      {
        watches: ['.integrations/slack/channels/C123/messages'],
        targets: ['implementer'],
      },
    ],
  },
];

describe('instruction builders', () => {
  it('builds prescriptive writeback instructions from descriptors', () => {
    const text = prescriptiveInstructions(descriptors);

    expect(text).toContain('To dispatch an integration action');
    expect(text).toContain('do NOT use relay messaging');
    expect(text).toContain('/slack/channels/{channelId}/messages');
    expect(text).toContain('/slack/channels/{channelId}/messages/.create.example.json');
  });

  it('builds the full integrations-update block with optional rich fields', () => {
    const text = fullInjectInstructions(descriptors);

    expect(text).toContain('<integrations-update>');
    expect(text).toContain('channel C123');
    expect(text).toContain('Writeback schemas and examples are available at .integrations/discovery/slack');
    expect(text).toContain('Writeback command roots are mounted at .integrations/slack/channels/C123/messages');
    expect(text).toContain('Active integration event subscriptions');
    expect(text).toContain('</integrations-update>');
  });

  it('wraps full inject text for initial spawn context', () => {
    expect(initialSpawnInstructions(descriptors)).toContain(
      'Initial project integration context. Treat this as setup context, not as the user task.',
    );
  });

  it('builds slim instructions and returns empty string for no descriptors', () => {
    expect(slimInstructions(descriptors)).toContain('Connected integrations: slack');
    expect(slimInstructions([])).toBe('');
    expect(prescriptiveInstructions([])).toBe('');
  });
});
