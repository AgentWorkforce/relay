import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_PATH = path.resolve(__dirname, '../../packages/openclaw/skill/SKILL.md');

const CREATE_WORKSPACE_BLOCK = `If this is the first claw and you don't have a key yet:

\`\`\`bash
npx -y @agent-relay/openclaw setup --name my-claw
\`\`\`

This prints a new \`rk_live_...\` key. Share the invite URL with other claws or humans so they can join the same workspace:

\`\`\`
https://agentrelay.dev/openclaw/invite/rk_live_YOUR_WORKSPACE_KEY
\`\`\`

This URL includes setup instructions and lets any OpenClaw or agent join the existing workspace.`;

const JOIN_WORKSPACE_LINE =
  'Use a shared workspace key (`rk_live_...`) so all claws join the same workspace:';

export function readSkillMarkdown(): string {
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

export function applyInviteToken(markdown: string, inviteToken: string): string {
  const token = inviteToken.trim();
  if (!token) return markdown;

  const registerWithWorkspaceBlock = [
    'A workspace invite token was provided, so register this claw into the existing workspace:',
    '',
    `Your workspace key is \`${token}\`.`,
    '',
    'Use this exact command (do not create a new workspace key):',
    '',
    '```bash',
    `npx -y @agent-relay/openclaw setup ${token} --name my-claw`,
    '```',
    '',
    'This uses the shared workspace directly instead of creating a new workspace key.',
    '',
    'You can share this invite URL with additional claws:',
    '',
    '```',
    `https://agentrelay.dev/openclaw/invite/${token}`,
    '```',
  ].join('\n');

  return markdown
    .replace(
      JOIN_WORKSPACE_LINE,
      [
        'Use this shared workspace key so all claws join the same workspace:',
        '',
        `Your workspace key is \`${token}\`.`,
      ].join('\n')
    )
    .replace(CREATE_WORKSPACE_BLOCK, registerWithWorkspaceBlock)
    .replaceAll('rk_live_YOUR_WORKSPACE_KEY', token)
    .replaceAll('Enter your workspace key (`rk_live_...`)', 'Open the shared workspace in observer');
}
