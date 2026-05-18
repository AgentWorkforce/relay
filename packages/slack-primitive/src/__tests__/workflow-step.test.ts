import { describe, expect, it } from 'vitest';

import { SlackAction, type SlackActionResult } from '../types.js';
import {
  SlackStepExecutor,
  slackStepConfigFromWorkflowStep,
  type SlackStepConfig,
} from '../workflow-step.js';
import type { SlackClient } from '../client.js';

describe('SlackStepExecutor', () => {
  it('keeps numeric-looking threadTs as a string after workflow param resolution', () => {
    const config = slackStepConfigFromWorkflowStep(
      {
        name: 'announce',
        type: 'integration',
        integration: 'slack',
        action: 'postMessage',
      },
      {
        text: 'PR opened',
        threadTs: '1715273540.123456',
        unfurl: 'true',
        mentions: '["@dev"]',
      }
    );

    expect(config.threadTs).toBe('1715273540.123456');
    expect(config.unfurl).toBe(true);
    expect(config.mentions).toEqual(['@dev']);
  });

  it('surfaces the real error for failed default data-mode steps', async () => {
    const executor = new SlackStepExecutor();
    const client = {
      executeAction: async (): Promise<SlackActionResult> => ({
        success: false,
        output: '',
        error: 'channel_not_found',
      }),
    } as unknown as SlackClient;

    const result = await executor.execute(
      {
        name: 'announce',
        action: SlackAction.PostMessage,
        channel: '#missing',
        text: 'PR opened',
      } satisfies SlackStepConfig,
      { client }
    );

    expect(result.output).toBe('"channel_not_found"');
  });
});
