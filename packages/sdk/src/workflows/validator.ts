import type { RelayYamlConfig, AgentDefinition, WorkflowStep } from './types.js';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  fix?: string;
  location?: string; // e.g. "step:analyze" or "agent:analyst"
}

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateWorkflow(config: RelayYamlConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Validate channel name format (must be lowercase alphanumeric + hyphens)
  const channel = (config as any).swarm?.channel ?? (config as any).channel;
  if (channel && !CHANNEL_NAME_RE.test(channel)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_CHANNEL_NAME',
      message: `Channel name "${channel}" is invalid. Must be lowercase alphanumeric and hyphens, starting with a letter or number.`,
      fix: `Use .toLowerCase().replace(/[^a-z0-9-]/g, '-') on the channel name.`,
      location: 'swarm:channel',
    });
  }

  const agentMap = new Map(config.agents.map((a) => [a.name, a]));
  const hasReviewerAgent = config.agents.some((a) => {
    const role = a.role?.toLowerCase() ?? '';
    const name = a.name.toLowerCase();
    return (
      a.preset === 'reviewer' ||
      role.includes('review') ||
      role.includes('critic') ||
      role.includes('verifier') ||
      role.includes('qa') ||
      name.includes('review')
    );
  });

  for (const workflow of config.workflows ?? []) {
    const hasInteractiveAgentSteps = workflow.steps.some((step) => {
      if (step.type === 'deterministic' || step.type === 'worktree') return false;
      if (!step.agent) return false;
      const raw = agentMap.get(step.agent);
      if (!raw) return false;
      return resolveForValidation(raw).interactive !== false;
    });
    if (hasInteractiveAgentSteps && !hasReviewerAgent) {
      issues.push({
        severity: 'warning',
        code: 'NO_REVIEW_AGENT',
        message: `Workflow "${workflow.name}" has interactive agent steps but no obvious reviewer agent. The runner can auto-fallback, but dedicated reviewers improve step hardening.`,
        fix: `Add an agent with role/preset like \`reviewer\`, \`critic\`, or \`verifier\`.`,
        location: `workflow:${workflow.name}`,
      });
    }

    for (const step of workflow.steps ?? []) {
      if (step.type === 'deterministic' || step.type === 'worktree') continue;
      if (!step.agent) continue;

      const rawDef = agentMap.get(step.agent);
      if (!rawDef) {
        issues.push({
          severity: 'error',
          code: 'UNKNOWN_AGENT',
          message: `Step "${step.name}" references unknown agent "${step.agent}"`,
          location: `step:${step.name}`,
        });
        continue;
      }

      // Resolve preset
      const def = resolveForValidation(rawDef);
      const task = step.task ?? '';

      // Check 1: step chaining on interactive agent
      if (def.interactive !== false && /\{\{steps\.[^}]+\}\}/.test(task)) {
        issues.push({
          severity: 'warning',
          code: 'CHAIN_ON_INTERACTIVE',
          message: `Step "${step.name}" uses {{steps.X.output}} but agent "${step.agent}" is interactive. PTY output includes TUI chrome — step chaining will receive raw terminal output.`,
          fix: `Add \`interactive: false\` to agent "${step.agent}", or use \`preset: worker\` / \`preset: reviewer\`.`,
          location: `step:${step.name}`,
        });
      }

      // Check 2: interactive codex missing /exit in task
      if (def.interactive !== false && def.cli === 'codex' && !task.includes('/exit')) {
        issues.push({
          severity: 'warning',
          code: 'CODEX_NO_EXIT',
          message: `Step "${step.name}" uses interactive codex but the task has no /exit instruction. Interactive codex may hang indefinitely.`,
          fix: `End the task with an explicit /exit example:\n  When done, output:\n  TASK_COMPLETE\n  /exit`,
          location: `step:${step.name}`,
        });
      }

      // Check 3: interactive agent with no sub-agent guardrail on complex tasks
      if (
        def.interactive !== false &&
        def.cli === 'claude' &&
        task.length > 500 &&
        !task.includes('do not') &&
        !task.includes('Do NOT') &&
        !task.includes('mcp__relaycast__agent_add') &&
        !task.includes('add_agent')
      ) {
        issues.push({
          severity: 'info',
          code: 'CLAUDE_NO_SPAWN_GUARD',
          message: `Step "${step.name}" uses interactive claude with a long task. Claude may spontaneously spawn sub-agents via relay MCP tools.`,
          fix: `Add "Do NOT use mcp__relaycast__agent_add or add_agent to spawn sub-agents." to the task, or use \`interactive: false\`.`,
          location: `step:${step.name}`,
        });
      }

      // Check 4: non-interactive agent that references relay messaging tools in task
      if (
        def.interactive === false &&
        (task.includes('mcp__relaycast__message_dm_send') || task.includes('mcp__relaycast__message_post') || task.includes('mcp__relaycast__message_inbox_check'))
      ) {
        issues.push({
          severity: 'warning',
          code: 'NONINTERACTIVE_RELAY',
          message: `Step "${step.name}" has \`interactive: false\` but the task mentions relay tools. Non-interactive agents cannot use relay MCP tools.`,
          fix: `Remove relay tool calls from the task, or set the agent to interactive.`,
          location: `step:${step.name}`,
        });
      }
    }

    // Check 5: maxConcurrency vs interactive agent count
    const interactiveSteps = (workflow.steps ?? []).filter((s) => {
      if (s.type === 'deterministic') return false;
      const def = agentMap.get(s.agent ?? '');
      return def && resolveForValidation(def).interactive !== false;
    });
    const maxConc = config.swarm.maxConcurrency ?? 10;
    if (interactiveSteps.length > 4 && maxConc > 4) {
      issues.push({
        severity: 'warning',
        code: 'HIGH_CONCURRENCY',
        message: `Workflow "${workflow.name}" has ${interactiveSteps.length} interactive steps with maxConcurrency: ${maxConc}. Spawning many interactive PTY agents simultaneously can saturate the broker and cause spawn timeouts.`,
        fix: `Set \`maxConcurrency: 3\` or lower, or convert implementation agents to \`interactive: false\`.`,
        location: `workflow:${workflow.name}`,
      });
    }
  }

  return issues;
}

function resolveForValidation(def: AgentDefinition): AgentDefinition {
  if (!def.preset) return def;
  const nonInteractive = ['worker', 'reviewer', 'analyst'];
  if (nonInteractive.includes(def.preset) && def.interactive === undefined) {
    return { ...def, interactive: false };
  }
  return def;
}

export function formatValidationReport(issues: ValidationIssue[], yamlPath: string): string {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const infos = issues.filter((i) => i.severity === 'info');

  const lines: string[] = [`Validating ${yamlPath}...`, ''];

  if (issues.length === 0) {
    lines.push('No issues found');
    return lines.join('\n');
  }

  const icon: Record<string, string> = { error: 'ERROR', warning: 'WARN', info: 'INFO' };

  for (const issue of issues) {
    const loc = issue.location ? ` [${issue.location}]` : '';
    lines.push(`${icon[issue.severity]} ${issue.message}${loc}`);
    if (issue.fix) {
      lines.push(`  -> ${issue.fix}`);
    }
    lines.push('');
  }

  const summary: string[] = [];
  if (errors.length) summary.push(`${errors.length} error${errors.length > 1 ? 's' : ''}`);
  if (warnings.length) summary.push(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`);
  if (infos.length) summary.push(`${infos.length} info`);
  lines.push(summary.join(', '));

  return lines.join('\n');
}
