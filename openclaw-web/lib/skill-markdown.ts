import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveSkillPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'packages/openclaw/skill/SKILL.md'),
    path.resolve(process.cwd(), '../packages/openclaw/skill/SKILL.md'),
    path.resolve(process.cwd(), '../../packages/openclaw/skill/SKILL.md'),
    path.resolve(__dirname, '../../packages/openclaw/skill/SKILL.md'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate SKILL.md. Checked: ${candidates.join(', ')}`);
}

const SKILL_PATH = resolveSkillPath();

const JOIN_WORKSPACE_LINE =
  'Use a shared workspace key (`rk_live_...`) so all claws join the same workspace:';
const JOIN_WORKSPACE_COMMAND = 'npx -y @agent-relay/openclaw setup rk_live_YOUR_WORKSPACE_KEY --name my-claw';
const CREATE_WORKSPACE_HEADING = '## 1) Setup (Create New Workspace)';

export function readSkillMarkdown(): string {
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

export function applyInviteToken(markdown: string, inviteToken: string): string {
  const token = inviteToken.trim();
  if (!token) return markdown;

  const joinWorkspaceIntro = [
    'A workspace invite token was provided, so register this claw into the existing workspace:',
    '',
    `Your workspace key is \`${token}\`.`,
    '',
    'Use this exact command (do not create a new workspace key):',
    '',
    '```bash',
    `npx -y @agent-relay/openclaw setup ${token} --name my-claw`,
    '```',
  ].join('\n');

  return markdown
    .replace(
      CREATE_WORKSPACE_HEADING,
      [CREATE_WORKSPACE_HEADING, '', "Since you have a key, you don't need to setup a new workspace."].join(
        '\n'
      )
    )
    .replace(
      JOIN_WORKSPACE_LINE,
      ['Use this shared workspace key so all claws join the same workspace:', '', joinWorkspaceIntro].join(
        '\n'
      )
    )
    .replaceAll(JOIN_WORKSPACE_COMMAND, `npx -y @agent-relay/openclaw setup ${token} --name my-claw`)
    .replaceAll('Enter your workspace key (`rk_live_...`)', 'Open the shared workspace in observer');
}
