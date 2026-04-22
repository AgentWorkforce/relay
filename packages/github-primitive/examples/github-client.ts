import { GitHubClient } from '../src/client.js';
import type { GitHubRuntimeConfig } from '../src/types.js';

const [owner = 'AgentWorkforce', repo = 'relay'] = (process.env.GITHUB_REPO || 'AgentWorkforce/relay').split(
  '/'
);

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

async function main(): Promise<void> {
  const github = await GitHubClient.create(githubConfig);
  const runtime = await github.getRuntime();
  const repository = await github.getRepo(owner, repo);
  const branches = await github.listBranches(owner, repo);

  console.log(`Runtime: ${runtime}`);
  console.log(`Repository: ${repository.fullName}`);
  console.log(`Default branch: ${repository.defaultBranch}`);
  console.log(`Branches: ${branches.map((branch) => branch.name).join(', ')}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
