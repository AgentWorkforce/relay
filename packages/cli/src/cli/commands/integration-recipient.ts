import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { HarnessDriverClient } from '@agent-relay/harness-driver';
import { getProjectPaths } from '@agent-relay/config';
import { connectProjectBrokerClient } from '../lib/project-broker-client.js';
import { resolveBaseUrl, resolveWorkspaceKey, type SdkClientOptions } from '../lib/sdk-client.js';

export interface RecipientLaunch {
  rollback(): Promise<void>;
  close(): void;
}

export interface RecipientLaunchInput {
  name: string;
  cli: string;
  args?: string[];
  provider: string;
  resource: string;
  cwd?: string;
  brokerConnectionPath?: string;
  task?: string;
  options: SdkClientOptions;
}

async function verifyRecipientIsolation(input: RecipientLaunchInput): Promise<void> {
  const membership = await fetch(
    new URL(
      `/v1/agents/${encodeURIComponent(input.name)}`,
      resolveBaseUrl(input.options) ?? 'https://cast.agentrelay.com'
    ),
    {
      headers: { authorization: `Bearer ${resolveWorkspaceKey(input.options)}` },
      signal: AbortSignal.timeout(15_000),
    }
  );
  const detail = membership.ok
    ? ((await membership.json()) as { data?: { channels?: unknown[] } })
    : undefined;
  if (!Array.isArray(detail?.data?.channels) || detail.data.channels.length !== 0) {
    throw new Error(
      `Recipient ${input.name} live channel isolation did not verify (HTTP ${membership.status}); no subscription resources were created.`
    );
  }
}

/** A registry row is not proof that a harness exists. Create no subscriptions until this resolves. */
export async function launchSubscriptionRecipient(input: RecipientLaunchInput): Promise<RecipientLaunch> {
  const workerCwd = input.cwd ? resolve(input.cwd) : undefined;
  if (workerCwd) {
    try {
      if (!statSync(workerCwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new Error(`Invalid recipient cwd: ${workerCwd} must be an existing directory`);
    }
  }
  const client = input.brokerConnectionPath
    ? HarnessDriverClient.connect({ connectionPath: resolve(input.brokerConnectionPath) })
    : connectProjectBrokerClient(getProjectPaths().projectRoot);
  let owned: Awaited<ReturnType<typeof client.spawnCli>> | undefined;
  try {
    const session = await client.getSession();
    if (session.workspace_key !== resolveWorkspaceKey(input.options)) {
      throw new Error(
        'The local broker belongs to a different workspace; select the matching broker before --spawn.'
      );
    }
    const existing = (await client.listAgents()).find((agent) => agent.name === input.name);
    if (existing) {
      if (existing.ready !== true || !existing.pid || existing.pid <= 0 || existing.cli !== input.cli) {
        throw new Error(`Existing ${input.name} is not a confirmed live ${input.cli} worker.`);
      }
      process.kill(existing.pid, 0);
      await verifyRecipientIsolation(input);
      return { rollback: async () => {}, close: () => client.disconnect() };
    }
    if (
      session.spawn_capabilities?.explicit_empty_channels !== true ||
      session.spawn_capabilities?.create_only_identity !== true
    ) {
      throw new Error(
        'The selected broker does not confirm isolated, create-only spawn support; upgrade to a release containing Relay PR #1708 before --spawn.'
      );
    }
    owned = await client.spawnCli({
      name: input.name,
      cli: input.cli,
      channels: [],
      ...(input.args ? { args: input.args } : {}),
      ...(workerCwd ? { cwd: workerCwd } : {}),
      task:
        input.task ??
        `Monitor pushed ${input.provider} events for the explicit resource ${input.resource}. Wait for incoming events; do not poll provider or channel history. No broader subscription is authorized by this task.`,
    });
    if (!Array.isArray(owned.channels) || owned.channels.length !== 0) {
      throw new Error(
        `Recipient ${input.name} channel isolation did not verify; the selected broker must confirm an explicit empty channel list (Relay PR #1708).`
      );
    }
    const ready = await owned.waitForReady(90_000);
    if (ready.reason !== 'ready' || !ready.pid || ready.pid <= 0) {
      throw new Error(
        `Recipient ${input.name} failed startup: ${ready.reason}${ready.exit ? ` (${JSON.stringify(ready.exit)})` : ''}`
      );
    }
    process.kill(ready.pid, 0);
    await verifyRecipientIsolation(input);

    return {
      rollback: async () => {
        await owned!.release('subscription setup failed', { deleteIdentity: true });
      },
      close: () => client.disconnect(),
    };
  } catch (error) {
    try {
      if (owned) await owned.release('subscription startup failed', { deleteIdentity: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Recipient startup failed and worker cleanup needs retry'
      );
    } finally {
      client.disconnect();
    }
    throw error;
  }
}

/** Owner-authorized endpoint joins the exact identity without rotating its agent token. */
export async function resolveSubscriptionAgentChannel(
  name: string,
  options: SdkClientOptions
): Promise<string> {
  const response = await fetch(
    new URL(
      `/v1/agents/${encodeURIComponent(name)}/subscription-channel`,
      resolveBaseUrl(options) ?? 'https://cast.agentrelay.com'
    ),
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${resolveWorkspaceKey(options)}` },
    }
  );
  if (!response.ok) {
    const detail = (await response.json().catch(() => undefined)) as
      | { error?: { code?: unknown } }
      | undefined;
    const code =
      typeof detail?.error?.code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(detail.error.code)
        ? ` ${detail.error.code}`
        : '';
    const remedy =
      response.status === 404 || response.status === 405
        ? ' Upgrade the selected Relaycast deployment to a release containing agent subscription channels (relaycast PR #387) before retrying.'
        : '';
    throw new Error(
      `Could not provision @${name} subscription routing (HTTP ${response.status}${code}).${remedy} No subscription resources were created.`
    );
  }
  const body = (await response.json()) as {
    data?: { name?: string; members?: Array<{ agent_name?: string }> };
  };
  if (!body.data?.name || body.data.members?.length !== 1 || body.data.members[0].agent_name !== name) {
    throw new Error(`Subscription channel membership did not verify for @${name}`);
  }
  return body.data.name;
}
