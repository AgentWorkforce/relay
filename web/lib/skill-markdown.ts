import agentRelaySkillMarkdown from '../content/agent-relay/SKILL.md?raw';
import openClawSkillMarkdown from '../content/openclaw/SKILL.md?raw';

const JOIN_WORKSPACE_LINE =
  'Use a shared workspace key (`rk_live_...`) so all claws join the same workspace:';
const CREATE_WORKSPACE_HEADING = '## 1) Setup (Create New Workspace)';
const OBSERVER_AUTH_LINE = 'Authenticate with workspace key (`rk_live_...`).';
const TOKEN_PLACEHOLDER = 'rk_live_YOUR_WORKSPACE_KEY';
const SETUP_SKIP_NOTE = 'Since you already have a workspace key, skip Step 1 and continue with Step 2 below.';

export function readAgentRelaySkillMarkdown(): string {
  return agentRelaySkillMarkdown;
}

export function readOpenClawSkillMarkdown(): string {
  return openClawSkillMarkdown;
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
    `npx -y @agent-relay/openclaw@latest setup ${token} --name my-claw`,
    '```',
  ].join('\n');

  return markdown
    .replace(CREATE_WORKSPACE_HEADING, () => [CREATE_WORKSPACE_HEADING, '', SETUP_SKIP_NOTE].join('\n'))
    .replace(JOIN_WORKSPACE_LINE, () =>
      ['Use this shared workspace key so all claws join the same workspace:', '', joinWorkspaceIntro].join(
        '\n'
      )
    )
    .replaceAll(TOKEN_PLACEHOLDER, () => token)
    .replaceAll(OBSERVER_AUTH_LINE, () => `Authenticate with workspace key \`${token}\`.`);
}
