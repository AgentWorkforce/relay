import type { RelayState } from './index.js';

interface HookContext {
  hook(name: string, handler: HookHandler): void;
}

interface SessionIdleResult {
  inject: string;
  continue: boolean;
}

interface SessionCompactingResult {
  preserve: string;
}

type HookHandler = () =>
  | SessionIdleResult
  | SessionCompactingResult
  | void
  | Promise<SessionIdleResult | SessionCompactingResult | void>;

interface RelayMessage {
  id: string;
  from: string;
  text: string;
  channel?: string;
  thread?: string;
  ts: string;
}

interface InboxCheckResponse {
  messages?: RelayMessage[];
}

export function registerHooks(ctx: HookContext, state: RelayState): void {
  // These OpenCode hook names are provisional per specs/cli-native-plugins.md section 5.
  ctx.hook('session.idle', async () => handleSessionIdle(state));
  ctx.hook('session.compacting', async () => handleSessionCompacting(state));
  ctx.hook('session.end', async () => handleSessionEnd(state));
}

async function handleSessionIdle(
  state: RelayState
): Promise<SessionIdleResult | void> {
  if (!state.connected || !state.token) {
    return;
  }

  const now = Date.now();
  if (now - state.lastIdlePollAt < state.idlePollIntervalMs) {
    return;
  }

  // Update the watermark before the request to avoid tight polling loops on errors.
  state.lastIdlePollAt = now;

  const messages = await pollInbox(state);
  if (messages.length === 0) {
    return;
  }

  return {
    inject: formatInjectedMessages(messages),
    continue: true,
  };
}

function handleSessionCompacting(
  state: RelayState
): SessionCompactingResult | void {
  if (!state.connected) {
    return;
  }

  return {
    preserve: buildCompactionPreserve(state),
  };
}

async function handleSessionEnd(state: RelayState): Promise<void> {
  if (!state.connected) {
    return;
  }

  try {
    for (const agent of state.spawned.values()) {
      if (agent.status !== 'running') {
        continue;
      }

      try {
        agent.process.kill('SIGTERM');
      } catch {
        // Ignore process cleanup failures during shutdown.
      }
    }
  } finally {
    state.connected = false;
  }
}

async function pollInbox(state: RelayState): Promise<RelayMessage[]> {
  const response = await fetch(`${normalizeBaseUrl(state.apiBaseUrl)}/inbox/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Relay API error: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as InboxCheckResponse;
  return Array.isArray(payload.messages) ? payload.messages : [];
}

function normalizeBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end--;
  return end === baseUrl.length ? baseUrl : baseUrl.slice(0, end);
}

function formatInjectedMessages(messages: RelayMessage[]): string {
  return messages
    .map((message) => {
      const prefix = message.channel
        ? `Relay message from ${message.from} [#${message.channel}]`
        : `Relay message from ${message.from}`;
      return `${prefix}: ${message.text}`;
    })
    .join('\n\n');
}

function buildCompactionPreserve(state: RelayState): string {
  const workerSummary =
    state.spawned.size === 0
      ? '  (none)'
      : Array.from(state.spawned.entries())
          .map(
            ([name, agent]) => `  - ${name}: ${agent.status} - "${agent.task}"`
          )
          .join('\n');

  return [
    '## Relay State (preserve across compaction)',
    `- Connected as: ${state.agentName ?? '(unregistered)'}`,
    `- Workspace: ${formatWorkspace(state.workspace)}`,
    '- Spawned workers:',
    workerSummary,
  ].join('\n');
}

function formatWorkspace(workspace: string | null): string {
  if (!workspace) {
    return '(unknown)';
  }

  return workspace.length > 16
    ? `${workspace.slice(0, 16)}...`
    : workspace;
}
