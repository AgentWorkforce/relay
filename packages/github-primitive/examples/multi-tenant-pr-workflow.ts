/**
 * Multi-tenant pull-request workflow.
 *
 * Cloud's reality: every workspace (AgentWorkforce, MSD, NightCTO, ...)
 * has its own GitHub App installation. The primitive's per-step `config`
 * field lets one workflow route different actions through different
 * Nango connections — no need for one workflow per tenant.
 *
 * The usual cloud pattern:
 *
 *   1. A resolver helper — lives in cloud, NOT in this primitive — maps
 *      { workspaceId, repo } -> { connectionId, providerConfigKey }.
 *      Recommended signature:
 *
 *         githubConfigForRepo({ repo, workspaceId }): Promise<GitHubRuntimeConfig>
 *
 *      It reads the workspace_integrations table, picks the row whose
 *      provider matches the target repo's app, and returns a ready-to-
 *      use config object.
 *
 *   2. Workflow authors call that resolver at step-build time and pass
 *      the result as `config` to each `createGitHubStep` call.
 *
 * This example simulates the resolver with a static table so the
 * illustration is self-contained — in production, swap it for the DB
 * lookup.
 *
 * Run:
 *   NANGO_SECRET_KEY=... \
 *   AGENTWORKFORCE_CONNECTION_ID=... \
 *   MSD_CONNECTION_ID=... \
 *   npx tsx examples/multi-tenant-pr-workflow.ts
 */

import { WorkflowRunner, type RelayYamlConfig } from '@agent-relay/sdk/workflows';

import { GitHubStepExecutor, createGitHubStep } from '../src/workflow-step.js';
import type { GitHubRuntimeConfig, RepositoryRef } from '../src/types.js';

// ─── Resolver (stand-in for cloud's real implementation) ───────────────

interface TenantConnection {
  workspaceId: string;
  providerConfigKey: string; // 'github-agentworkforce' | 'github-msd' | 'github-nightcto'
  connectionIdEnvVar: string; // env var that carries the Nango connection id
}

// In cloud, this table is the workspace_integrations DB rows joined to
// the Nango provider registry. Here we keep it inline for illustration.
const TENANTS: Record<string, TenantConnection> = {
  'AgentWorkforce/cloud': {
    workspaceId: 'rw_agentworkforce',
    providerConfigKey: 'github-agentworkforce',
    connectionIdEnvVar: 'AGENTWORKFORCE_CONNECTION_ID',
  },
  'AgentWorkforce/sage': {
    workspaceId: 'rw_agentworkforce',
    providerConfigKey: 'github-agentworkforce',
    connectionIdEnvVar: 'AGENTWORKFORCE_CONNECTION_ID',
  },
  'msd-ventures/platform': {
    workspaceId: 'rw_msd',
    providerConfigKey: 'github-msd',
    connectionIdEnvVar: 'MSD_CONNECTION_ID',
  },
};

function githubConfigForRepo(opts: {
  repo: string | RepositoryRef;
  /** Workspace scope. Optional — cloud-owned repos default to the shared app. */
  workspaceId?: string;
}): GitHubRuntimeConfig {
  const repoKey = typeof opts.repo === 'string' ? opts.repo : `${opts.repo.owner}/${opts.repo.repo}`;
  const tenant = TENANTS[repoKey];

  if (!tenant) {
    throw new Error(
      `No GitHub connection mapped for ${repoKey} — register it in the tenants table or workspace_integrations.`
    );
  }

  const connectionId = process.env[tenant.connectionIdEnvVar];
  if (!connectionId) {
    throw new Error(`Missing ${tenant.connectionIdEnvVar} — set the Nango connection id for ${repoKey}.`);
  }

  return {
    runtime: 'auto',
    nango: {
      connectionId,
      providerConfigKey: tenant.providerConfigKey,
      secretKey: process.env.NANGO_SECRET_KEY,
    },
    relayCloud: {
      apiUrl: process.env.RELAY_CLOUD_API_URL,
      accessToken: process.env.RELAY_CLOUD_API_TOKEN,
      workspaceId: opts.workspaceId ?? tenant.workspaceId,
    },
  };
}

// ─── Workflow ────────────────────────────────────────────────────────────

const agentworkforceRepo = 'AgentWorkforce/cloud';
const msdRepo = 'msd-ventures/platform';

const executor = new GitHubStepExecutor({ runtime: 'auto' });

const config: RelayYamlConfig = {
  version: '1.0',
  name: 'multi-tenant-pr-workflow',
  description:
    'Open PRs in two tenants — AgentWorkforce/cloud (shared app) and msd-ventures/platform (MSD app) — from one workflow by varying per-step config.',
  swarm: { pattern: 'pipeline' },
  agents: [],
  workflows: [
    {
      name: 'multi-tenant-pr-workflow',
      steps: [
        // ─── Tenant A: AgentWorkforce ───────────────────────────────
        createGitHubStep({
          name: 'inspect-agentworkforce-cloud',
          action: 'getRepo',
          repo: agentworkforceRepo,
          config: githubConfigForRepo({ repo: agentworkforceRepo }),
          output: { mode: 'summary', includeRuntime: true, pretty: true },
        }),

        createGitHubStep({
          name: 'open-pr-agentworkforce',
          dependsOn: ['inspect-agentworkforce-cloud'],
          action: 'createPR',
          repo: agentworkforceRepo,
          params: {
            // Pretend we prepared this branch in an earlier workflow step
            // (push-branch in the caller workflow).
            head: 'feat/typed-webhook-consumers',
            base: 'main',
            title: 'feat(web): typed webhook-consumer config',
            body: "Routes through AgentWorkforce's github-agentworkforce Nango connection.",
            draft: true,
          },
          config: githubConfigForRepo({ repo: agentworkforceRepo }),
          output: { mode: 'data', format: 'json', path: 'data.html_url' },
        }),

        // ─── Tenant B: MSD ──────────────────────────────────────────
        // Same workflow, same action verbs, different connection
        // resolved by the per-step `config` field. Runs sequentially
        // here but could run in parallel — tenants are independent.
        createGitHubStep({
          name: 'inspect-msd-platform',
          dependsOn: ['open-pr-agentworkforce'],
          action: 'getRepo',
          repo: msdRepo,
          config: githubConfigForRepo({ repo: msdRepo }),
          output: { mode: 'summary', includeRuntime: true, pretty: true },
        }),

        createGitHubStep({
          name: 'open-pr-msd',
          dependsOn: ['inspect-msd-platform'],
          action: 'createPR',
          repo: msdRepo,
          params: {
            head: 'integrations/agent-relay-webhook',
            base: 'main',
            title: 'feat: wire up Agent Relay webhook receiver',
            body: "Routes through MSD's github-msd Nango connection — separate GitHub App install.",
            draft: true,
          },
          config: githubConfigForRepo({ repo: msdRepo }),
          output: { mode: 'data', format: 'json', path: 'data.html_url' },
        }),
      ],
    },
  ],
  errorHandling: { strategy: 'fail-fast' },
};

async function main(): Promise<void> {
  console.log('Opening PRs in two tenants via per-step GitHub config overrides:');
  console.log(`  ${agentworkforceRepo}  → connection ${TENANTS[agentworkforceRepo].providerConfigKey}`);
  console.log(`  ${msdRepo}             → connection ${TENANTS[msdRepo].providerConfigKey}`);
  console.log();

  const runner = new WorkflowRunner({
    cwd: process.cwd(),
    executor,
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
