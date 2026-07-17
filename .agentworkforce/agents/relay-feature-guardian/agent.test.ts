import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolveManifestPath } from './agent.ts';

const persona = JSON.parse(readFileSync(new URL('./persona.json', import.meta.url), 'utf8')) as {
  inputs: { SLACK_CHANNEL: { default: string } };
};

describe('relay-feature-guardian runtime paths', () => {
  it('reads the manifest from the cloned relay repository', () => {
    assert.equal(
      resolveManifestPath('/home/daytona/workspace'),
      '/home/daytona/workspace/github/repos/AgentWorkforce/relay/.agentworkforce/features/manifest.yaml'
    );
  });

  it('defaults delivery to the relay feature-check channel', () => {
    assert.equal(persona.inputs.SLACK_CHANNEL.default, 'C0AEKNLDNKW');
  });
});
