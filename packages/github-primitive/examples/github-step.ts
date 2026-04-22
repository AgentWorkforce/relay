import { WorkflowRunner, type RelayYamlConfig } from '@agent-relay/sdk/workflows';

import { GitHubClient } from '../src/client.js';
import { GitHubStepExecutor, createGitHubStep } from '../src/workflow-step.js';
import type { GitHubRuntimeConfig } from '../src/types.js';

const repo = process.env.GITHUB_REPO ?? 'AgentWorkforce/relay';

const githubConfig: GitHubRuntimeConfig = {
  runtime: (process.env.GITHUB_RUNTIME as GitHubRuntimeConfig['runtime']) ?? 'auto',
  nango: {
    connectionId: process.env.NANGO_GITHUB_CONNECTION_ID,
    providerConfigKey: process.env.NANGO_GITHUB_PROVIDER_CONFIG_KEY,
  },
  relayCloud: {
    apiUrl: process.env.RELAY_CLOUD_API_URL,
    accessToken: process.env.RELAY_CLOUD_API_TOKEN,
    workspaceId: process.env.WORKSPACE_ID,
  },
};

const githubExecutor = new GitHubStepExecutor(githubConfig);

const config: RelayYamlConfig = {
  version: '1.0',
  name: 'github-primitive-workflow',
  description: 'GitHub primitive workflow with runtime auto-detection and chained output.',
  swarm: {
    pattern: 'pipeline',
  },
  agents: [],
  workflows: [
    {
      name: 'github-primitive-workflow',
      steps: [
        createGitHubStep({
          name: 'inspect-repository',
          action: 'getRepo',
          repo,
          output: {
            mode: 'summary',
            includeRuntime: true,
            pretty: true,
          },
        }),
        createGitHubStep({
          name: 'list-open-issues',
          dependsOn: ['inspect-repository'],
          action: 'listIssues',
          repo,
          params: {
            state: 'open',
            perPage: 5,
          },
          output: {
            mode: 'summary',
            includeRuntime: true,
            pretty: true,
          },
        }),
        createGitHubStep({
          name: 'read-readme',
          dependsOn: ['list-open-issues'],
          action: 'readFile',
          repo,
          params: {
            path: 'README.md',
          },
          output: {
            mode: 'data',
            format: 'text',
          },
        }),
      ],
    },
  ],
  errorHandling: {
    strategy: 'fail-fast',
  },
};

async function main(): Promise<void> {
  const detection = await GitHubClient.detect(githubConfig);

  console.log(`GitHub runtime selected: ${detection.runtime}`);
  console.log(`Detection source: ${detection.source}`);
  console.log(`Local gh CLI: ${detection.local.available ? 'available' : 'unavailable'}`);
  console.log(`Cloud GitHub: ${detection.cloud.available ? 'available' : 'unavailable'}`);
  console.log(detection.reason);

  const runner = new WorkflowRunner({
    cwd: process.cwd(),
    executor: githubExecutor,
  });

  const result = await runner.execute(config);
  console.log(`GitHub workflow completed: ${result.status}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
