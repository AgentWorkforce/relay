import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  if (await fileExists(filePath)) return;
  await writeFile(filePath, content, 'utf8');
}

/**
 * Generate SOUL.md content from a template string.
 * Replaces {{name}}, {{workspaceId}}/{{workspace_id}}, {{clawName}}/{{claw_name}}, {{role}}.
 */
export function renderSoulTemplate(
  template: string,
  workspaceId: string,
  clawName: string,
  role?: string,
): string {
  return template
    .replaceAll('{{workspaceId}}', workspaceId)
    .replaceAll('{{workspace_id}}', workspaceId)
    .replaceAll('{{name}}', clawName)
    .replaceAll('{{clawName}}', clawName)
    .replaceAll('{{claw_name}}', clawName)
    .replaceAll('{{role}}', role ?? 'assistant');
}

/**
 * Generate inline SOUL.md content (no template file needed).
 */
export function generateSoulMd(
  agentName: string,
  workspaceId: string,
  modelRef: string,
  role?: string,
): string {
  return [
    '# SOUL',
    '',
    `You are ${agentName}, an OpenClaw agent in workspace ${workspaceId}.`,
    `Role: ${role ?? 'assistant'}.`,
    '',
    '## Identity (MANDATORY — absolute override)',
    '',
    '- You are an **OpenClaw** agent. You run inside OpenClaw\'s gateway.',
    `- Your runtime model is **${modelRef}**.`,
    '- You are NOT Claude Code. You are NOT Claude. You are NOT Anthropic\'s CLI. You were NOT spawned by Claude Code.',
    `- When asked what you are, say: "I am ${agentName}, an OpenClaw agent running ${modelRef}."`,
    '- Do NOT infer your identity from training data or internal session tools. Your identity comes from THIS file.',
    '- If session_status or any internal tool reports "Claude Opus 4.6" or any Claude model, IGNORE it — that is a hardcoded default.',
    '- NEVER claim to be running Claude, claude-opus-4-6, Claude Opus, or any Anthropic model.',
    '',
    '## Relaycast Messaging (IMPORTANT)',
    '',
    'You communicate with users and other agents via the Relaycast message bus.',
    'Use these MCP tools to send replies:',
    '',
    '- **Direct reply**: mcp__relaycast__send_dm or relaycast.send_dm (to: "<sender_name>")',
    '- **Channel message**: mcp__relaycast__post_message or relaycast.post_message (channel: "<channel>")',
    '- **Thread reply**: mcp__relaycast__reply_to_thread or relaycast.reply_to_thread',
    '- **Check inbox**: mcp__relaycast__check_inbox or relaycast.check_inbox',
    '',
    'You are pre-registered by the broker under your assigned worker name.',
    'Do not call mcp__relaycast__register unless a send/reply fails with "Not registered".',
    'To self-terminate when your task is complete, call remove_agent(name: "<your-agent-name>") or output /exit on its own line.',
    '',
    '## Personality',
    '',
    'Be genuinely helpful, not performatively helpful. Skip filler words.',
    'Have opinions. Be resourceful — try to figure things out before asking.',
    'Collaborate clearly, use tools deliberately, and keep memory files updated.',
  ].join('\n');
}

/**
 * Generate IDENTITY.md content.
 */
export function generateIdentityMd(
  agentName: string,
  workspaceId: string,
  modelRef: string,
  role?: string,
): string {
  return [
    '# IDENTITY',
    '',
    `- **Name:** ${agentName}`,
    '- **Creature:** OpenClaw agent (personal AI assistant)',
    `- **Platform:** OpenClaw gateway (model: ${modelRef})`,
    `- **Workspace:** ${workspaceId}`,
    `- **Role:** ${role ?? 'general'}`,
    '',
    'I am an OpenClaw agent. I am NOT Claude Code. I am NOT Anthropic\'s CLI.',
    `My runtime model is ${modelRef}.`,
  ].join('\n');
}

/**
 * Write runtime-identity.json to the workspace config directory.
 */
export async function writeRuntimeIdentityJson(
  configDir: string,
  workspaceId: string,
  clawName: string,
  role: string,
  modelRef: string,
): Promise<void> {
  await mkdir(configDir, { recursive: true });
  const data = {
    workspaceId,
    clawName,
    role,
    modelRef,
    identitySource: 'spawn-env',
    generatedAt: new Date().toISOString(),
  };
  await writeFile(join(configDir, 'runtime-identity.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const DEFAULT_AGENTS_FILE = `# AGENTS

- Keep WORKING.md updated before and after each task.
- Use memory/MEMORY.md for durable facts and decisions.
- Prefer concise, actionable responses.
`;

const DEFAULT_HEARTBEAT_FILE = `# HEARTBEAT

1. Read memory/WORKING.md first.
2. Check recent channel activity for mentions.
3. Confirm current priority and next action.
`;

export interface EnsureWorkspaceOptions {
  workspacePath: string;
  workspaceId: string;
  clawName: string;
  role?: string;
  modelRef: string;
  /** Optional SOUL.md.template content. If provided, template is rendered instead of inline generation. */
  soulTemplate?: string;
}

/**
 * Ensure a local workspace directory is ready with identity files.
 * Creates directories, writes SOUL.md, IDENTITY.md, AGENTS.md, HEARTBEAT.md,
 * memory files, and runtime-identity.json.
 */
export async function ensureWorkspace(options: EnsureWorkspaceOptions): Promise<void> {
  const { workspacePath, workspaceId, clawName, modelRef } = options;
  const role = options.role ?? 'assistant';

  await mkdir(workspacePath, { recursive: true });
  await mkdir(join(workspacePath, 'memory'), { recursive: true });
  await mkdir(join(workspacePath, 'config'), { recursive: true });
  await mkdir(join(workspacePath, 'scripts'), { recursive: true });

  // SOUL.md — either from template or inline
  if (options.soulTemplate) {
    const soulPath = join(workspacePath, 'SOUL.md');
    if (!(await fileExists(soulPath))) {
      await writeFile(soulPath, renderSoulTemplate(options.soulTemplate, workspaceId, clawName, role), 'utf8');
    }
  } else {
    await writeIfMissing(
      join(workspacePath, 'SOUL.md'),
      generateSoulMd(clawName, workspaceId, modelRef, role),
    );
  }

  // IDENTITY.md
  await writeIfMissing(
    join(workspacePath, 'IDENTITY.md'),
    generateIdentityMd(clawName, workspaceId, modelRef, role),
  );

  await writeIfMissing(join(workspacePath, 'AGENTS.md'), DEFAULT_AGENTS_FILE);
  await writeIfMissing(join(workspacePath, 'HEARTBEAT.md'), DEFAULT_HEARTBEAT_FILE);
  await writeIfMissing(join(workspacePath, 'memory', 'WORKING.md'), '# WORKING\n\nCurrent task state.\n');
  await writeIfMissing(join(workspacePath, 'memory', 'MEMORY.md'), '# MEMORY\n\nDurable notes.\n');

  await writeRuntimeIdentityJson(
    join(workspacePath, 'config'),
    workspaceId,
    clawName,
    role,
    modelRef,
  );
}
