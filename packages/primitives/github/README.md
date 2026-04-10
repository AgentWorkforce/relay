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
