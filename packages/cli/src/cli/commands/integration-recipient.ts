import { statSync } from 'node:fs';
import { resolve } from 'node:path';
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
  provider: string;
  resource: string;
  cwd?: string;
  task?: string;
  options: SdkClientOptions;
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
  const client = connectProjectBrokerClient(getProjectPaths().projectRoot);
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
      return { rollback: async () => {}, close: () => client.disconnect() };
    }
    owned = await client.spawnCli({
      name: input.name,
      cli: input.cli,
      channels: [],
      ...(workerCwd ? { cwd: workerCwd } : {}),
      task:
        input.task ??
        `Monitor pushed ${input.provider} events for the explicit resource ${input.resource}. Wait for incoming events; do not poll provider or channel history. No broader subscription is authorized by this task.`,
    });
    const ready = await owned.waitForReady(90_000);
    if (ready.reason !== 'ready' || !ready.pid || ready.pid <= 0) {
      throw new Error(
        `Recipient ${input.name} failed startup: ${ready.reason}${ready.exit ? ` (${JSON.stringify(ready.exit)})` : ''}`
      );
    }
    process.kill(ready.pid, 0);
    return {
      rollback: async () => {
        await owned!.release('subscription setup failed');
      },
      close: () => client.disconnect(),
    };
  } catch (error) {
    try {
      if (owned) await owned.release('subscription startup failed');
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
      headers: { authorization: `Bearer ${resolveWorkspaceKey(options)}` },
    }
  );
  if (!response.ok)
    throw new Error(
      `Could not provision @${name} subscription routing (HTTP ${response.status}); the server must support agent subscription channels.`
    );
  const body = (await response.json()) as {
    data?: { name?: string; members?: Array<{ agent_name?: string }> };
  };
  if (!body.data?.name || body.data.members?.length !== 1 || body.data.members[0].agent_name !== name) {
    throw new Error(`Subscription channel membership did not verify for @${name}`);
  }
  return body.data.name;
}
