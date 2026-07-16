import { definePersona } from '@agentworkforce/persona-kit';

/**
 * Relay Feature Guardian — cycles through the Relay feature manifest hourly,
 * posting one feature check to Slack and asking the team to confirm (or flag)
 * whether the feature works as intended.
 *
 * Over the course of a week it covers every feature in the manifest. Memory
 * tracks which features have been quizzed so it doesn't repeat until the full
 * cycle resets.
 *
 * Set SLACK_CHANNEL to the channel where checks are posted (e.g. #relay-health).
 * Set SLACK_USER_WILL and SLACK_USER_KHALIQ to the Slack user IDs to @mention.
 */
export default definePersona({
  id: 'relay-feature-guardian',
  intent: 'relay-orchestrator',
  tags: ['relay', 'verification', 'proactive', 'health'],
  description:
    'Cycles through every Relay CLI feature hourly, posting a Slack check asking the team to confirm whether the feature works as intended. Tracks progress across the full manifest and resets after a complete cycle.',
  cloud: true,
  sandbox: false,
  useSubscription: true,

  integrations: {
    slack: {
      scope: { channels: '/slack/channels/**' }
    }
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Slack channel to post feature checks to (e.g. relay-health or general).',
      env: 'SLACK_CHANNEL',
      default: 'C0BHWJSF309',
      picker: { provider: 'slack', resource: 'channels' }
    },
    SLACK_USER_WILL: {
      description: 'Slack user ID for Will (e.g. U01234ABCDE). Used for @mentions in checks.',
      env: 'SLACK_USER_WILL',
      optional: true
    },
    SLACK_USER_KHALIQ: {
      description: 'Slack user ID for Khaliq (e.g. U01234ABCDE). Used for @mentions in checks.',
      env: 'SLACK_USER_KHALIQ',
      optional: true
    }
  },

  memory: { enabled: true, scopes: ['workspace'], ttlDays: 14 },

  onEvent: './agent.ts'
});
