import { workflow } from '@agent-relay/sdk/workflows';

/**
 * GitHub Traffic Stats to PostHog
 * 
 * Fetches daily traffic stats (views and clones) from the GitHub API
 * and records them in PostHog for analytics dashboards.
 * 
 * Usage:
 *   agent-relay run workflows/github-traffic-to-posthog.ts
 * 
 * Environment:
 *   GITHUB_TOKEN - GitHub PAT with repo:status scope (optional, improves rate limit)
 *   POSTHOG_API_KEY - Override PostHog API key (optional)
 *   POSTHOG_HOST - Override PostHog host (optional)
 */

async function main() {
  const result = await workflow('github-traffic-to-posthog')
    .description('Fetch GitHub repo traffic stats and send to PostHog')
    .pattern('linear')
    .channel('wf-telemetry')
    .timeout(300000)

    .agent('collector', {
      cli: 'claude',
      preset: 'worker',
      role: 'Collect GitHub traffic stats and send to PostHog',
      model: 'sonnet-4-20250514',
      retries: 1,
    })

    .step('fetch-traffic-views', {
      type: 'deterministic',
      command: `
        set -e
        cd "$PWD"
        echo "=== Fetching GitHub Traffic Views ==="
        gh api /repos/AgentWorkforce/relay/traffic/views
      `,
      captureOutput: true,
      failOnError: true,
    })

    .step('fetch-traffic-clones', {
      type: 'deterministic',
      command: `
        set -e
        cd "$PWD"
        echo "=== Fetching GitHub Traffic Clones ==="
        gh api /repos/AgentWorkforce/relay/traffic/clones
      `,
      captureOutput: true,
      failOnError: true,
    })

    .step('send-to-posthog', {
      agent: 'collector',
      dependsOn: ['fetch-traffic-views', 'fetch-traffic-clones'],
      task: `Send GitHub traffic stats to PostHog.

Traffic Views data:
{{steps.fetch-traffic-views.output}}

Traffic Clones data:
{{steps.fetch-traffic-clones.output}}

The script already exists at scripts/send-github-traffic-to-posthog.ts

Execute it by:
1. Extract the JSON from both outputs (they may have prefix text from gh api)
2. Set environment variables VIEWS_DATA and CLONES_DATA with the raw JSON
3. Run: npx tsx scripts/send-github-traffic-to-posthog.ts

The script will parse the data and send to PostHog using the configured API key.

End with POSTHOG_SEND_COMPLETE.`,
      verification: { type: 'output_contains', value: 'POSTHOG_SEND_COMPLETE' },
      retries: 2,
    })

    .run({ cwd: process.cwd() });

  console.log('Workflow completed:', result.status);
  if (result.status === 'failed') {
    console.error('Error:', result.error);
    process.exit(1);
  }
}

main().catch(console.error);
