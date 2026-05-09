import { WorkflowRunner, type RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { GitHubStepExecutor, createGitHubStep } from '@agent-relay/github-primitive/workflow-step';
import type { AgentDefinition, RunnerStepExecutor, WorkflowStep } from '@agent-relay/workflow-types';

import { SlackStepExecutor, createSlackStep } from '../src/workflow-step.js';

const repo = process.env.GITHUB_REPO ?? 'AgentWorkforce/scratch';
const baseBranch = process.env.GITHUB_BASE_BRANCH ?? 'main';
const branchName = process.env.GITHUB_BRANCH_OVERRIDE ?? `examples/slack-primitive-${Date.now()}`;
const slackChannel = process.env.SLACK_CHANNEL ?? '#engineering';

const slackExecutor = new SlackStepExecutor({
  token: process.env.SLACK_BOT_TOKEN,
});
const githubExecutor = new GitHubStepExecutor();

const localExecutor: RunnerStepExecutor = {
  executeAgentStep(
    _step: WorkflowStep,
    _agentDef: AgentDefinition,
    _resolvedTask: string,
    _timeoutMs?: number
  ): Promise<string> {
    return Promise.reject(new Error('notify-on-pr only uses integration steps.'));
  },
  async executeIntegrationStep(
    step: WorkflowStep,
    resolvedParams: Record<string, string>,
    context: { workspaceId?: string }
  ): Promise<{ output: string; success: boolean }> {
    if (step.integration === 'github') {
      return githubExecutor.executeIntegrationStep(step, resolvedParams, context);
    }
    if (step.integration === 'slack') {
      return slackExecutor.executeIntegrationStep(step, resolvedParams);
    }
    return {
      success: false,
      output: `Unsupported integration "${step.integration ?? 'unknown'}"`,
    };
  },
};

const config: RelayYamlConfig = {
  version: '1.0',
  name: 'notify-on-pr',
  description: 'Open a GitHub pull request and announce it in Slack.',
  swarm: { pattern: 'pipeline' },
  agents: [],
  workflows: [
    {
      name: 'notify-on-pr',
      steps: [
        createGitHubStep({
          name: 'create-pr',
          action: 'createPR',
          repo,
          params: {
            title: `examples: slack primitive notification (${branchName})`,
            body: 'Opened by packages/slack-primitive/examples/notify-on-pr.ts.',
            base: baseBranch,
            head: branchName,
            draft: true,
          },
          output: {
            mode: 'data',
            format: 'json',
          },
        }),
        createSlackStep({
          name: 'announce-pr',
          dependsOn: ['create-pr'],
          action: 'postMessage',
          channel: slackChannel,
          text: 'PR opened: {{steps.create-pr.output.htmlUrl}}',
          unfurl: true,
          output: {
            mode: 'summary',
            format: 'json',
            pretty: true,
          },
        }),
      ],
    },
  ],
};

const runner = new WorkflowRunner({
  cwd: process.cwd(),
  executor: localExecutor,
});

await runner.execute(config);
