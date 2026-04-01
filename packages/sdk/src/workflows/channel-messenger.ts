import { stripAnsi as stripAnsiFn } from '../pty.js';
import type { StepOutcome } from './trajectory.js';
import type { AgentDefinition, WorkflowStepRow } from './types.js';

type StepStateLike = {
  row: Pick<WorkflowStepRow, 'agentName' | 'status'>;
};

export interface ChannelRelayLike {
  send(to: string, text: string): Promise<unknown>;
}

export interface ChannelMessengerOptions {
  postFn?: (text: string) => void;
}

export async function sendToChannel(
  relay: ChannelRelayLike,
  channel: string,
  message: string
): Promise<void> {
  await relay.send(channel, message);
}

export function truncateMessage(message: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  return message.length > maxLength ? message.slice(-maxLength) : message;
}

export function formatStepOutput(stepName: string, output: string, maxLength = 2000): string {
  const scrubbed = scrubForChannel(output);
  if (scrubbed.length === 0) {
    return `**[${stepName}]** Step completed — output written to disk`;
  }

  const preview = truncateMessage(scrubbed, maxLength);
  return `**[${stepName}] Output:**\n\`\`\`\n${preview}\n\`\`\``;
}

export function formatError(stepName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `**[${stepName}]** Failed: ${message}`;
}

export function scrubForChannel(text: string): string {
  // Strip system-reminder blocks (closed or unclosed) iteratively to avoid
  // polynomial backtracking (ReDoS) with [\s\S]*? on adversarial input.
  let withoutSystemReminders = text;
  const openTag = '<system-reminder>';
  const closeTag = '</system-reminder>';
  let idx: number;
  while ((idx = withoutSystemReminders.toLowerCase().indexOf(openTag)) !== -1) {
    const closeIdx = withoutSystemReminders.toLowerCase().indexOf(closeTag, idx + openTag.length);
    if (closeIdx !== -1) {
      withoutSystemReminders = withoutSystemReminders.slice(0, idx) + withoutSystemReminders.slice(closeIdx + closeTag.length);
    } else {
      // Unclosed tag — strip everything from the opening tag onward
      withoutSystemReminders = withoutSystemReminders.slice(0, idx);
      break;
    }
  }

  // Normalize CRLF and bare \r before stripping ANSI — PTY output often
  // contains \r\r\n which leaves stray \r after stripping that confuse line splitting.
  const normalized = withoutSystemReminders.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const ansiStripped = stripAnsiFn(normalized);

  // Unicode spinner / ornament characters used by Claude TUI animations.
  // Includes block-element chars (▗▖▘▝) used in the Claude Code header bar.
  const SPINNER =
    '\\u2756\\u2738\\u2739\\u273a\\u273b\\u273c\\u273d\\u2731\\u2732\\u2733\\u2734\\u2735\\u2736\\u2737\\u2743\\u2745\\u2746\\u25d6\\u25d7\\u25d8\\u25d9\\u2022\\u25cf\\u25cb\\u25a0\\u25a1\\u25b6\\u25c0\\u23f5\\u23f6\\u23f7\\u23f8\\u23f9\\u25e2\\u25e3\\u25e4\\u25e5\\u2597\\u2596\\u2598\\u259d\\u2bc8\\u2bc7\\u2bc5\\u2bc6\\u00b7' +
    '\\u2590\\u258c\\u2588\\u2584\\u2580\\u259a\\u259e' +
    '\\u2b21\\u2b22';
  const spinnerRe = new RegExp(`[${SPINNER}]`, 'gu');
  const spinnerClassRe = new RegExp(`^[\\s${SPINNER}]*$`, 'u');

  const boxDrawingOnlyRe = /^[\s\u2500-\u257f\u2580-\u259f\u25a0-\u25ff\-_=~]{3,}$/u;
  const brokerLogRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+(?:INFO|WARN|ERROR|DEBUG)\s/u;
  const claudeHeaderRe =
    /^(?:[\s\u2580-\u259f✢*·▗▖▘▝]+\s*)?(?:Claude\s+Code(?:\s+v?[\d.]+)?|(?:Sonnet|Haiku|Opus)\s*[\d.]+|claude-(?:sonnet|haiku|opus)-[\w.-]+|Running\s+on\s+claude)/iu;
  const dirBreadcrumbRe = /^\s*~[\\/]/u;
  const uiHintRe =
    /\b(?:Press\s+up\s+to\s+edit|tab\s+to\s+queue|bypass\s+permissions|esc\s+to\s+interrupt)\b/iu;
  const thinkingLineRe = new RegExp(`^[\\s${SPINNER}]*\\s*\\w[\\w\\s]*\\u2026\\s*$`, 'u');
  const cursorOnlyRe = /^[\s❯⎿›»◀▶←→↑↓⟨⟩⟪⟫·]+$/u;
  const cursorAgentRe =
    /^(?:Cursor Agent|[\s⬡⬢]*Generating[.\s]|\[Pasted text|Auto-run all|Add a follow-up|ctrl\+c to stop|shift\+tab|Auto$|\/\s*commands|@\s*files|!\s*shell|follow-ups?\s|The user ha)/iu;
  const slashCommandRe = /^\/\w+\s*$/u;
  const mcpJsonKvRe =
    /^\s*"(?:type|method|params|result|id|jsonrpc|tool|name|arguments|content|role|metadata)"\s*:/u;
  const meaningfulContentRe = /[a-zA-Z0-9]/u;

  const countJsonDepth = (line: string): number => {
    let depth = 0;
    for (const ch of line) {
      if (ch === '{' || ch === '[') depth += 1;
      if (ch === '}' || ch === ']') depth -= 1;
    }
    return depth;
  };

  const lines = ansiStripped.split('\n');
  const meaningful: string[] = [];
  let jsonDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (jsonDepth > 0) {
      jsonDepth += countJsonDepth(line);
      if (jsonDepth <= 0) jsonDepth = 0;
      continue;
    }

    if (trimmed.length === 0) continue;

    if (trimmed.startsWith('{') || /^\[\s*\{/.test(trimmed)) {
      jsonDepth = Math.max(countJsonDepth(line), 0);
      continue;
    }

    if (mcpJsonKvRe.test(line)) continue;
    if (spinnerClassRe.test(trimmed)) continue;
    if (boxDrawingOnlyRe.test(trimmed)) continue;
    if (brokerLogRe.test(trimmed)) continue;
    if (claudeHeaderRe.test(trimmed)) continue;
    if (dirBreadcrumbRe.test(trimmed)) continue;
    if (uiHintRe.test(trimmed)) continue;
    if (thinkingLineRe.test(trimmed)) continue;
    if (cursorOnlyRe.test(trimmed)) continue;
    if (cursorAgentRe.test(trimmed)) continue;
    if (slashCommandRe.test(trimmed)) continue;
    if (!meaningfulContentRe.test(trimmed)) continue;

    const alphanum = trimmed.replace(spinnerRe, '').replace(/\s+/g, '');
    if (alphanum.replace(/[^a-zA-Z0-9]/g, '').length <= 3) continue;

    meaningful.push(line);
  }

  return meaningful
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class ChannelMessenger {
  private readonly postFn?: (text: string) => void;

  constructor(options: ChannelMessengerOptions = {}) {
    this.postFn = options.postFn;
  }

  buildNonInteractiveAwareness(
    agentMap: Map<string, AgentDefinition>,
    stepStates: Map<string, StepStateLike>
  ): string | undefined {
    const nonInteractive = [...agentMap.values()].filter((agent) => agent.interactive === false);
    if (nonInteractive.length === 0) return undefined;

    const agentToSteps = new Map<string, string[]>();
    for (const [stepName, state] of stepStates) {
      const agentName = state.row.agentName;
      if (!agentName) continue;
      if (!agentToSteps.has(agentName)) agentToSteps.set(agentName, []);
      agentToSteps.get(agentName)!.push(stepName);
    }

    const lines = nonInteractive.map((agent) => {
      const stepRefs = (agentToSteps.get(agent.name) ?? []).map((stepName) => `{{steps.${stepName}.output}}`);
      return (
        `- ${agent.name} (${agent.cli}) — will return output when complete` +
        (stepRefs.length > 0 ? `. Access via: ${stepRefs.join(', ')}` : '')
      );
    });

    return (
      '\n\n---\n' +
      'Note: The following agents are non-interactive workers and cannot receive messages:\n' +
      lines.join('\n') +
      '\n' +
      'Do NOT attempt to message these agents. Use the {{steps.<name>.output}} references above to access their results.'
    );
  }

  buildRelayRegistrationNote(cli: string, agentName: string): string {
    if (cli === 'claude') return '';
    return (
      '---\n' +
      'RELAY SETUP — do this FIRST before any other relay tool:\n' +
      `1. Call: register(name="${agentName}")\n` +
      '   This authenticates you in the Relaycast workspace.\n' +
      '   ALL relay tools (mcp__relaycast__message_dm_send, mcp__relaycast__message_inbox_check, mcp__relaycast__message_post, etc.) require\n' +
      '   registration first — they will fail with "Not registered" otherwise.\n' +
      `2. Your agent name is "${agentName}" — use this exact name when registering.`
    );
  }

  buildDelegationGuidance(cli: string, timeoutMs?: number): string {
    const timeoutNote = timeoutMs
      ? `You have approximately ${Math.round(timeoutMs / 60000)} minutes before this step times out. ` +
        'Plan accordingly — delegate early if the work is substantial.\n\n'
      : '';
    const subAgentOption =
      cli === 'claude'
        ? 'Option 2 — Use built-in sub-agents (Task tool) for research or scoped work:\n' +
          '  - Good for exploring code, reading files, or making targeted changes\n' +
          '  - Can run multiple sub-agents in parallel\n\n'
        : '';

    return (
      '---\n' +
      'AUTONOMOUS DELEGATION — READ THIS BEFORE STARTING:\n' +
      timeoutNote +
      'Before diving in, assess whether this task is too large or complex for a single agent. ' +
      'If it involves multiple independent subtasks, touches many files, or could take a long time, ' +
      'you should break it down and delegate to helper agents to avoid timeouts.\n\n' +
      'Option 1 — Spawn relay agents (for real parallel coding work):\n' +
      '  - mcp__relaycast__agent_add(name="helper-1", cli="claude", task="Specific subtask description")\n' +
      '  - Coordinate via mcp__relaycast__message_dm_send(to="helper-1", text="...")\n' +
      '  - Check on them with mcp__relaycast__message_inbox_check()\n' +
      '  - Clean up when done: mcp__relaycast__agent_remove(name="helper-1")\n\n' +
      subAgentOption +
      'Guidelines:\n' +
      '- You are the lead — delegate but stay in control, track progress, integrate results\n' +
      '- Give each helper a clear, self-contained task with enough context to work independently\n' +
      "- For simple or quick work, just do it yourself — don't over-delegate\n" +
      '- Always release spawned relay agents when their work is complete\n' +
      '- When spawning non-claude agents (codex, gemini, etc.), prepend to their task:\n' +
      '  "RELAY SETUP: First call register(name=\'<exact-agent-name>\') before any other relay tool."'
    );
  }

  postCompletionReport(
    workflowName: string,
    outcomes: StepOutcome[],
    summary: string,
    confidence: number
  ): void {
    const completed = outcomes.filter((outcome) => outcome.status === 'completed');
    const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');
    const retried = outcomes.filter((outcome) => outcome.attempts > 1);

    const lines: string[] = [
      `## Workflow **${workflowName}** — Complete`,
      '',
      summary,
      `Confidence: ${Math.round(confidence * 100)}%`,
      '',
      '### Steps',
      ...completed.map(
        (outcome) =>
          `- **${outcome.name}** (${outcome.agent}) — passed${outcome.verificationPassed ? ' (verified)' : ''}${outcome.attempts > 1 ? ` after ${outcome.attempts} attempts` : ''}`
      ),
      ...skipped.map((outcome) => `- **${outcome.name}** — skipped`),
    ];

    if (retried.length > 0) {
      lines.push('', '### Retries');
      for (const outcome of retried) {
        lines.push(`- ${outcome.name}: ${outcome.attempts} attempts`);
      }
    }

    this.postFn?.(lines.join('\n'));
  }

  postFailureReport(workflowName: string, outcomes: StepOutcome[], errorMsg: string): void {
    const completed = outcomes.filter((outcome) => outcome.status === 'completed');
    const failed = outcomes.filter((outcome) => outcome.status === 'failed');
    const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');

    const lines: string[] = [
      `## Workflow **${workflowName}** — Failed`,
      '',
      `${completed.length}/${outcomes.length} steps passed. Error: ${errorMsg}`,
      '',
      '### Steps',
      ...completed.map((outcome) => `- **${outcome.name}** (${outcome.agent}) — passed`),
      ...failed.map((outcome) => `- **${outcome.name}** (${outcome.agent}) — FAILED: ${outcome.error ?? 'unknown'}`),
      ...skipped.map((outcome) => `- **${outcome.name}** — skipped`),
    ];

    this.postFn?.(lines.join('\n'));
  }
}
