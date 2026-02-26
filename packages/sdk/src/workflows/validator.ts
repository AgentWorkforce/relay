import type { RelayYamlConfig, AgentDefinition, WorkflowStep } from './types.js';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  fix?: string;
  location?: string; // e.g. "step:analyze" or "agent:analyst"
}

export function validateWorkflow(config: RelayYamlConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const agentMap = new Map(config.agents.map((a) => [a.name, a]));

  for (const workflow of config.workflows ?? []) {
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
        !task.includes('relay_spawn') &&
        !task.includes('add_agent')
      ) {
        issues.push({
          severity: 'info',
          code: 'CLAUDE_NO_SPAWN_GUARD',
          message: `Step "${step.name}" uses interactive claude with a long task. Claude may spontaneously spawn sub-agents via relay MCP tools.`,
          fix: `Add "Do NOT use relay_spawn or add_agent to spawn sub-agents." to the task, or use \`interactive: false\`.`,
          location: `step:${step.name}`,
        });
      }

      // Check 4: non-interactive agent that references relay_send in task
      if (
        def.interactive === false &&
        (task.includes('relay_send') || task.includes('post_message') || task.includes('check_inbox'))
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
