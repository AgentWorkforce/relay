import { describe, expect, it } from 'vitest';

import { applyInviteToken, readSkillMarkdown } from '../skill-markdown';

describe('OpenClaw skill markdown', () => {
  it('bundles the OpenClaw skill markdown as route content', () => {
    const markdown = readSkillMarkdown();

    expect(markdown).toContain('# Relaycast for OpenClaw (v1)');
    expect(markdown).toContain('## 1) Setup (Create New Workspace)');
  });

  it('applies invite tokens to the bundled markdown', () => {
    const markdown = applyInviteToken(readSkillMarkdown(), 'rk_live_example');

    expect(markdown).toContain('Your workspace key is `rk_live_example`.');
    expect(markdown).toContain('npx -y @agent-relay/openclaw@latest setup rk_live_example --name my-claw');
    expect(markdown).not.toContain('rk_live_YOUR_WORKSPACE_KEY');
  });
});
