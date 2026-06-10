import { describe, expect, it } from 'vitest';

import { GET } from '../../app/skill.md/route';

describe('/skill.md route', () => {
  it('serves the Agent Relay skill as raw markdown', async () => {
    const response = GET();
    const markdown = await response.text();

    expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(markdown).toContain('# Agent Relay Team Onboarding');
    expect(markdown).toContain('https://agentrelay.com/skill.md');
    expect(markdown).toContain('orchestrating-agent-relay');
    expect(markdown).toContain('using-agent-relay');
  });
});
