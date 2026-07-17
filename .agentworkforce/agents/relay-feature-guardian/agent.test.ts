import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveManifestPath } from './agent.ts';

const persona = JSON.parse(readFileSync(new URL('./persona.json', import.meta.url), 'utf8')) as {
  inputs: { SLACK_CHANNEL: { default: string } };
};

describe('relay-feature-guardian runtime paths', () => {
  it('reads the manifest from the cloned relay repository', () => {
    expect(resolveManifestPath('/home/daytona/workspace')).toBe(
      '/home/daytona/workspace/github/repos/AgentWorkforce/relay/.agentworkforce/features/manifest.yaml'
    );
  });

  it('defaults delivery to the relay feature-check channel', () => {
    expect(persona.inputs.SLACK_CHANNEL.default).toBe('C0AEKNLDNKW');
  });
});
