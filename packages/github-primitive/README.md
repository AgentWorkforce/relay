# @agent-relay/github-primitive

GitHub workflow primitive for Agent Relay. It exposes a typed client and a
workflow integration step that can run through the local `gh` CLI or a cloud
GitHub proxy.

## Runtime Selection

The primitive supports three runtime modes:

- `auto`: prefer cloud when Nango or relay-cloud credentials are present,
  otherwise use the local `gh` CLI when available.
- `local`: use `gh api` from the current machine.
- `cloud`: use Nango first, then relay-cloud proxy when configured.

```ts
import { GitHubClient } from '@agent-relay/github-primitive';

const github = await GitHubClient.create({
  runtime: 'auto',
});

const repo = await github.getRepo('AgentWorkforce', 'relay');
console.log(repo.defaultBranch);
```

## Actions

The client and workflow step support:

- Repositories: `listRepos`, `getRepo`
- Issues: `listIssues`, `createIssue`, `updateIssue`, `closeIssue`
- Pull requests: `listPRs`, `getPR`, `createPR`, `updatePR`, `mergePR`
- Files: `listFiles`, `readFile`, `createFile`, `updateFile`, `deleteFile`
- Branches and commits: `listBranches`, `createBranch`, `listCommits`, `createCommit`
- Identity: `getUser`, `listOrganizations`

## Workflow Step

```ts
import { createGitHubStep } from '@agent-relay/github-primitive/workflow-step';

createGitHubStep({
  name: 'read-readme',
  action: 'readFile',
  repo: 'AgentWorkforce/relay',
  params: {
    path: 'README.md',
  },
  output: {
    mode: 'data',
    format: 'text',
  },
});
```

See `examples/github-step.ts` for a workflow runner example and
`examples/github-client.ts` for a standalone client example.

## End-to-end PR workflow

`examples/end-to-end-pr-workflow.ts` walks the full PR lifecycle against
a single runtime:

1. `getRepo` — inspect + log the selected runtime.
2. `createBranch` off the base branch.
3. `createFile` — write a marker file on the new branch.
4. `createPR` — the core integration step cloud workflows migrate to.
5. `getPR` — round-trip verify.
6. `updatePR` — edit the PR body without code changes.
7. `listPRs` — confirm indexability.
8. (commented) `mergePR` — off by default so the example never merges
   anything real.

Run against a scratch repo:

```
GITHUB_REPO=AgentWorkforce/scratch npx tsx \
  packages/github-primitive/examples/end-to-end-pr-workflow.ts
```

Runtime selection is automatic:

| Path        | Triggered when                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Local `gh`  | `gh auth status` succeeds and no cloud creds are set                                                  |
| Nango       | `NANGO_SECRET_KEY` + `NANGO_GITHUB_CONNECTION_ID` + `NANGO_GITHUB_PROVIDER_CONFIG_KEY` present        |
| relay-cloud | `RELAY_CLOUD_API_URL` + `RELAY_CLOUD_API_TOKEN` + `WORKSPACE_ID` present (fallback when Nango absent) |

## Multi-tenant routing

In cloud, every workspace has its own GitHub App install — one Nango
connection per tenant. `createGitHubStep` accepts a per-step `config`
field so a single workflow can route different actions through
different connections. One workflow, many tenants.

`examples/multi-tenant-pr-workflow.ts` demonstrates this: it opens PRs
in `AgentWorkforce/cloud` (via the AgentWorkforce app) AND in an
MSD-owned repo (via MSD's app), from the same workflow definition, by
varying the `config:` field on each step.

### Cloud adoption: the resolver helper

The primitive stays tenant-unaware — it takes a `GitHubRuntimeConfig`
and does what it's told. The tenant lookup lives in cloud, in a small
helper:

```ts
// cloud/packages/web/lib/github/connection-resolver.ts
import type { GitHubRuntimeConfig } from '@agent-relay/github-primitive';

export async function githubConfigForRepo(opts: {
  repo: string; // "owner/repo"
  workspaceId?: string; // optional — cloud-owned repos default
}): Promise<GitHubRuntimeConfig> {
  const connection = await resolveWorkspaceIntegration(opts.workspaceId, 'github', opts.repo);

  return {
    runtime: 'auto',
    nango: {
      connectionId: connection.connectionId,
      providerConfigKey: connection.providerConfigKey, // 'github-agentworkforce' | 'github-msd' | 'github-nightcto' | ...
      secretKey: process.env.NANGO_SECRET_KEY,
    },
    relayCloud: {
      apiUrl: process.env.CLOUD_API_URL,
      accessToken: process.env.CLOUD_API_TOKEN,
      workspaceId: opts.workspaceId,
    },
  };
}
```

Workflow authors in cloud then write:

```ts
createGitHubStep({
  name: 'open-pr',
  action: 'createPR',
  repo: 'AgentWorkforce/cloud',
  params: { title, head, base, body },
  config: await githubConfigForRepo({
    repo: 'AgentWorkforce/cloud',
    workspaceId: process.env.RELAY_WORKSPACE_ID,
  }),
});
```

One resolver, one call-site shape. Adding a new GitHub App install is a
`workspace_integrations` row + (optionally) a `NANGO_*` secret — no
code change in the workflows that create PRs.
