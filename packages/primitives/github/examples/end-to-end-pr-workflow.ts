/**
 * End-to-end pull-request workflow using the GitHub primitive.
 *
 * Demonstrates the full PR lifecycle from a single workflow definition:
 *   1. Detect + log which runtime will be used (local gh vs Nango vs
 *      relay-cloud proxy).
 *   2. createBranch — branch off the default branch for the change.
 *   3. createFile — write a timestamped marker file on the new branch.
 *   4. createPR — open the pull request. This is the core interface the
 *      cloud workflows need to swap to.
 *   5. getPR — round-trip verify.
 *   6. updatePR — add a description edit (shows mutation).
 *   7. listPRs — confirm it appears in the default filter.
 *   8. (commented out) mergePR — the last mile. Left off by default so
 *      running this example does NOT merge anything against real repos.
 *
 * The same file runs identically in three environments because the
 * primitive's runtime selection handles the transport:
 *
 *   - LOCAL              gh CLI (needs `gh auth status` to succeed)
 *   - CLOUD (tenant)     Nango — NANGO_GITHUB_CONNECTION_ID +
 *                        NANGO_GITHUB_PROVIDER_CONFIG_KEY +
 *                        NANGO_SECRET_KEY
 *   - CLOUD (fallback)   relay-cloud proxy — RELAY_CLOUD_API_URL +
 *                        RELAY_CLOUD_API_TOKEN + WORKSPACE_ID
 *
 * Run:
 *   GITHUB_REPO=AgentWorkforce/scratch npx tsx examples/end-to-end-pr-workflow.ts
 *
 * Defaults to AgentWorkforce/scratch (a sandbox repo) so no one
 * accidentally opens a PR against a real repo. Override via env vars.
 */

import { WorkflowRunner, type RelayYamlConfig } from '@agent-relay/sdk/workflows';

import { GitHubClient } from '../src/client.js';
import { GitHubStepExecutor, createGitHubStep } from '../src/workflow-step.js';
import type { GitHubRuntimeConfig } from '../src/types.js';

const repo = process.env.GITHUB_REPO ?? 'AgentWorkforce/scratch';
const baseBranch = process.env.GITHUB_BASE_BRANCH ?? 'main';
const branchName = process.env.GITHUB_BRANCH_OVERRIDE ?? `examples/github-primitive-${Date.now()}`;
const markerPath = `examples/github-primitive-runs/${Date.now()}.md`;

const githubConfig: GitHubRuntimeConfig = {
  // `auto` prefers cloud credentials when present, otherwise falls back
  // to the local `gh` CLI. Override with GITHUB_RUNTIME=local|cloud when
  // you want to pin a specific path.
  runtime: (process.env.GITHUB_RUNTIME as GitHubRuntimeConfig['runtime']) ?? 'auto',

  // Cloud path A — Nango. Per-tenant GitHub App installation. Cloud
  // callers typically resolve this via a connection-resolver helper
  // that maps { workspaceId, repo } -> { connectionId, providerConfigKey }.
  nango: {
    connectionId: process.env.NANGO_GITHUB_CONNECTION_ID,
    providerConfigKey: process.env.NANGO_GITHUB_PROVIDER_CONFIG_KEY,
    secretKey: process.env.NANGO_SECRET_KEY,
  },

  // Cloud path B — relay-cloud GitHub proxy. Used when Nango isn't
  // wired but a relay-cloud bearer token is available.
  relayCloud: {
    apiUrl: process.env.RELAY_CLOUD_API_URL,
    accessToken: process.env.RELAY_CLOUD_API_TOKEN,
    workspaceId: process.env.WORKSPACE_ID,
  },
};

const githubExecutor = new GitHubStepExecutor(githubConfig);

const config: RelayYamlConfig = {
  version: '1.0',
  name: 'end-to-end-pr-workflow',
  description:
    'Walk through the full PR lifecycle — branch, commit, open, update, list — using the GitHub primitive.',
  swarm: { pattern: 'pipeline' },
  agents: [],
  workflows: [
    {
      name: 'end-to-end-pr-workflow',
      steps: [
        // 1. Resolve the default branch — sanity check the connection
        //    works before we start making mutations.
        createGitHubStep({
          name: 'inspect-repo',
          action: 'getRepo',
          repo,
          output: {
            mode: 'summary',
            includeRuntime: true,
            pretty: true,
          },
        }),

        // 2. Create the feature branch off the base branch's HEAD.
        //    Chains {{steps.inspect-repo.output.data.defaultBranch}}
        //    when no base override is provided — here we keep it
        //    explicit for readability.
        createGitHubStep({
          name: 'create-branch',
          dependsOn: ['inspect-repo'],
          action: 'createBranch',
          repo,
          params: {
            branch: branchName,
            source: baseBranch,
          },
          output: { mode: 'data', format: 'json', path: 'ref' },
        }),

        // 3. Write a marker file on the new branch. createFile handles
        //    the blob + tree + commit dance for you.
        createGitHubStep({
          name: 'write-marker-file',
          dependsOn: ['create-branch'],
          action: 'createFile',
          repo,
          params: {
            path: markerPath,
            branch: branchName,
            content: [
              '# GitHub primitive example run',
              '',
              `- Runtime chosen: see workflow log for inspect-repo detection`,
              `- Generated: ${new Date().toISOString()}`,
              '',
              'This file is created by',
              '`packages/primitives/github/examples/end-to-end-pr-workflow.ts`',
              'to prove the full PR lifecycle works against the configured runtime.',
            ].join('\n'),
            message: `examples: github-primitive demo run ${new Date().toISOString()}`,
          },
          output: { mode: 'data', format: 'json', path: 'commit.sha' },
        }),

        // 4. Open the pull request. This is the core step cloud
        //    workflows need. title/body/head/base mirror the REST API
        //    shape — no translation work at the call site.
        createGitHubStep({
          name: 'open-pr',
          dependsOn: ['write-marker-file'],
          action: 'createPR',
          repo,
          params: {
            title: `examples: github-primitive end-to-end demo (${branchName})`,
            head: branchName,
            base: baseBranch,
            body: [
              '## Summary',
              '',
              'Automated PR opened by',
              '`packages/primitives/github/examples/end-to-end-pr-workflow.ts`',
              'to exercise the GitHub primitive interface end-to-end.',
              '',
              '## Runtime selection',
              '',
              'See the workflow log for the `inspect-repo` step — it logs the',
              'selected runtime (`local`, `nango`, or `relay-cloud`).',
              '',
              '## Safe to close',
              '',
              'This PR is a demonstration. No one should merge it — close it',
              'once you have inspected the end-to-end round-trip.',
            ].join('\n'),
            draft: true,
          },
          output: {
            mode: 'data',
            format: 'json',
            includeRuntime: true,
            includeMetadata: true,
            pretty: true,
          },
        }),

        // 5. Read the PR back to prove the resolver + runtime actually
        //    persisted the change, and to surface the PR number for
        //    downstream steps.
        createGitHubStep({
          name: 'verify-pr',
          dependsOn: ['open-pr'],
          action: 'getPR',
          repo,
          params: {
            // The output of `open-pr` is the Pulls REST response; we pull
            // the number off it for subsequent mutation.
            number: '{{steps.open-pr.output.data.number}}',
          },
          output: {
            mode: 'summary',
            includeRuntime: true,
            pretty: true,
          },
        }),

        // 6. Update the PR — shows how to use updatePR for edits that
        //    don't need code changes (body, title, draft state, etc.).
        createGitHubStep({
          name: 'edit-pr-body',
          dependsOn: ['verify-pr'],
          action: 'updatePR',
          repo,
          params: {
            number: '{{steps.open-pr.output.data.number}}',
            body: [
              '## Summary',
              '',
              'Automated PR opened by the GitHub primitive end-to-end',
              'example. This body was updated by the `edit-pr-body` step',
              'to demonstrate `updatePR` works through the same adapter.',
              '',
              '## Safe to close',
              '',
              'Demo — close, do not merge.',
            ].join('\n'),
          },
          output: { mode: 'result', format: 'json' },
        }),

        // 7. List open PRs to prove the new one is indexable.
        createGitHubStep({
          name: 'list-open-prs',
          dependsOn: ['edit-pr-body'],
          action: 'listPRs',
          repo,
          params: {
            state: 'open',
            perPage: 10,
          },
          output: { mode: 'summary', pretty: true },
        }),

        // 8. (Commented) The last mile — merge. Intentionally left off:
        //    running this example against a real repo should not merge
        //    anything. Uncomment when exercising a disposable scratch
        //    repo or CI harness.
        //
        // createGitHubStep({
        //   name: 'merge-pr',
        //   dependsOn: ['list-open-prs'],
        //   action: 'mergePR',
        //   repo,
        //   params: {
        //     number: '{{steps.open-pr.output.data.number}}',
        //     mergeMethod: 'squash',
        //     commitTitle: 'examples: github-primitive demo (squash)',
        //   },
        //   output: { mode: 'data', format: 'json' },
        // }),
      ],
    },
  ],
  errorHandling: { strategy: 'fail-fast' },
};

async function main(): Promise<void> {
  const detection = await GitHubClient.detect(githubConfig);

  console.log('────────────────────────────────────────');
  console.log(`repo:                 ${repo}`);
  console.log(`base branch:          ${baseBranch}`);
  console.log(`feature branch:       ${branchName}`);
  console.log(`runtime selected:     ${detection.runtime}`);
  console.log(`detection source:     ${detection.source}`);
  console.log(`local gh available:   ${detection.local.available}`);
  console.log(`cloud available:      ${detection.cloud.available}`);
  if (detection.reason) {
    console.log(`reason:               ${detection.reason}`);
  }
  console.log('────────────────────────────────────────');

  const runner = new WorkflowRunner({
    cwd: process.cwd(),
    executor: githubExecutor,
  });

  const result = await runner.execute(config);
  console.log(`\nWorkflow completed: ${result.status}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
