import skillMarkdown from '../../packages/openclaw/skill/SKILL.md';

type LambdaEvent = {
  rawPath?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    http?: {
      path?: string;
    };
  };
};

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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function withInviteToken(markdown: string, inviteToken: string): string {
  const token = inviteToken.trim();
  if (!token) return markdown;

  const registerWithWorkspaceBlock = [
    'A workspace invite token was provided, so register this claw into the existing workspace:',
    '',
    `Your workspace key is \`${token}\`.`,
    '',
    'Use this exact command (do not create a new workspace key):',
    '',
    '\`\`\`bash',
    `npx -y @agent-relay/openclaw setup ${token} --name my-claw`,
    '\`\`\`',
    '',
    'This uses the shared workspace directly instead of creating a new workspace key.',
    '',
    'You can share this invite URL with additional claws:',
    '',
    '\`\`\`',
    `https://agentrelay.dev/openclaw/invite/${token}`,
    '\`\`\`',
  ].join('\n');

  const updatedMarkdown = markdown
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

  return updatedMarkdown;
}

function parseInviteTokenFromPath(pathValue?: string): string | undefined {
  if (!pathValue) return undefined;

  const noQuery = pathValue.split('?')[0].replace(/\/+$/, '');
  const segments = noQuery.split('/').filter(Boolean);
  if (segments.length === 0) return undefined;

  const inviteIndex = segments.lastIndexOf('invite');
  if (inviteIndex >= 0 && segments[inviteIndex + 1]) {
    return decodeURIComponent(segments[inviteIndex + 1]);
  }

  // Fallback for routers that strip the matched prefix and only pass "/<token>".
  if (segments.length === 1 && segments[0] !== 'invite' && segments[0] !== 'openclaw') {
    return decodeURIComponent(segments[0]);
  }

  return undefined;
}

function resolveInviteToken(event: LambdaEvent): string | undefined {
  const queryToken = event.queryStringParameters?.invite_token?.trim();
  if (queryToken) return queryToken;

  return (
    parseInviteTokenFromPath(event.rawPath) ?? parseInviteTokenFromPath(event.requestContext?.http?.path)
  );
}

export const handler = async (event: LambdaEvent) => {
  const inviteToken = resolveInviteToken(event);
  if (!inviteToken) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: '<html><body><h1>Missing invite token</h1><p>Use /openclaw/invite/&lt;workspace-key&gt;.</p></body></html>',
    };
  }

  const markdown = withInviteToken(skillMarkdown, inviteToken);

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Relay for OpenClaw</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        background: #f7f7f5;
        color: #1f2937;
      }
      main {
        box-sizing: border-box;
        max-width: 980px;
        margin: 0 auto;
        padding: 24px 16px 40px;
      }
      h1 {
        font-size: 1.4rem;
        margin: 0 0 12px;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.45;
        border: 1px solid #d1d5db;
        border-radius: 10px;
        background: #ffffff;
        padding: 16px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent Relay for OpenClaw</h1>
      <pre>${escapeHtml(markdown)}</pre>
    </main>
  </body>
</html>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: html,
  };
};
