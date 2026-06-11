import { describe, expect, it } from 'vitest';

import { applyInviteToken, readAgentRelaySkillMarkdown, readOpenClawSkillMarkdown } from '../skill-markdown';

describe('Agent Relay skill markdown', () => {
  it('bundles the Agent Relay team onboarding markdown as route content', () => {
    const markdown = readAgentRelaySkillMarkdown();

    expect(markdown).toContain('# Agent Relay Team Onboarding');
    expect(markdown).toContain('https://agentrelay.com/skill');
    expect(markdown).toContain('orchestrating-agent-relay');
    expect(markdown).toContain('using-agent-relay');
  });
});

describe('OpenClaw skill markdown', () => {
  it('bundles the OpenClaw skill markdown as route content', () => {
    const markdown = readOpenClawSkillMarkdown();

    expect(markdown).toContain('# Relaycast for OpenClaw (v1)');
    expect(markdown).toContain('## 1) Setup (Create New Workspace)');
  });

  it('applies invite tokens to the bundled markdown', () => {
    const markdown = applyInviteToken(readOpenClawSkillMarkdown(), 'rk_live_example');

    expect(markdown).toContain('Your workspace key is `rk_live_example`.');
    expect(markdown).toContain('npx -y @agent-relay/openclaw@latest setup rk_live_example --name my-claw');
    expect(markdown).not.toContain('rk_live_YOUR_WORKSPACE_KEY');
  });
});
