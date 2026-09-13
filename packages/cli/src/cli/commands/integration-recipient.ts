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
      transport: 'pty',
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

const SUBSCRIPTION_CHANNEL_ATTEMPT_TIMEOUT_MS = 15_000;
const SUBSCRIPTION_CHANNEL_MAX_ATTEMPTS = 3;
const SUBSCRIPTION_CHANNEL_RETRY_BUDGET_MS = 30_000;
const SUBSCRIPTION_CHANNEL_FALLBACK_RETRY_MS = 2_000;
// The write-admission lane returns exactly this typed code on `withWriteAdmissionAuth`
// BEFORE the handler runs, so the request was never applied and is safe to repeat.
const SUBSCRIPTION_CHANNEL_BUSY_CODE = 'workspace_busy';

/** `Retry-After` delta-seconds or HTTP-date; null when absent, malformed, or non-finite. */
function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const delayMs = Number(raw) * 1_000;
    return Number.isFinite(delayMs) ? delayMs : null;
  }
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  return null;
}

function subscriptionChannelErrorCode(detail: { error?: { code?: unknown } } | undefined): string | null {
  const code = detail?.error?.code;
  return typeof code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? code : null;
}

function subscriptionChannelFailure(
  name: string,
  lastStatus: number,
  lastCode: string | null,
  lastRetryAfterMs: number | null,
  exhaustedByBudget: boolean
): Error {
  const budgetSeconds = Math.round(SUBSCRIPTION_CHANNEL_RETRY_BUDGET_MS / 1_000);
  if (lastStatus === 0) {
    return new Error(
      `Could not provision @${name} subscription routing: the subscription-channel retry budget (${budgetSeconds}s) was exhausted before the request. No subscription resources were created.`
    );
  }
  const codePart = lastCode ? ` ${lastCode}` : '';
  const retryPart =
    lastStatus === 429 && lastCode === SUBSCRIPTION_CHANNEL_BUSY_CODE && lastRetryAfterMs !== null
      ? ` Retry-After: ${Math.ceil(lastRetryAfterMs / 1_000)}s.`
      : '';
  const budgetPart = exhaustedByBudget
    ? ` The subscription-channel retry budget (${budgetSeconds}s) was exhausted.`
    : '';
  const remedy =
    lastStatus === 404 || lastStatus === 405
      ? ' Upgrade the selected Relaycast deployment to a release containing agent subscription channels (relaycast PR #387) before retrying.'
      : '';
  return new Error(
    `Could not provision @${name} subscription routing (HTTP ${lastStatus}${codePart}).${retryPart}${budgetPart}${remedy} No subscription resources were created.`
  );
}

/** Owner-authorized endpoint joins the exact identity without rotating its agent token. */
export async function resolveSubscriptionAgentChannel(
  name: string,
  options: SdkClientOptions
): Promise<string> {
  const origin = resolveBaseUrl(options) ?? 'https://cast.agentrelay.com';
  // Resolved once and reused: an explicit `--workspace-key` keeps precedence and
  // every attempt sends exactly the same fixed request.
  const authorization = `Bearer ${resolveWorkspaceKey(options)}`;
  const requestUrl = new URL(`/v1/agents/${encodeURIComponent(name)}/subscription-channel`, origin);
  const deadlineMs = Date.now() + SUBSCRIPTION_CHANNEL_RETRY_BUDGET_MS;
  let lastStatus = 0;
  let lastCode: string | null = null;
  let lastRetryAfterMs: number | null = null;
  for (let attempt = 1; ; attempt += 1) {
    // Total-deadline guard BEFORE every attempt, including after a late wakeup:
    // never start a fetch once the budget is spent, and never let an attempt's own
    // timeout run past the deadline.
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw subscriptionChannelFailure(name, lastStatus, lastCode, lastRetryAfterMs, true);
    }
    const attemptTimeoutMs = Math.min(SUBSCRIPTION_CHANNEL_ATTEMPT_TIMEOUT_MS, remainingMs);
    const response = await fetch(requestUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(attemptTimeoutMs),
      headers: { authorization },
      // Pin the exact POST target: a followed 3xx would prove only the redirect
      // target's behavior, not that the original handler was left unapplied.
      redirect: 'manual',
    });
    lastStatus = response.status;
    if (response.ok) {
      const body = (await response.json()) as {
        data?: { name?: string; members?: Array<{ agent_name?: string }> };
      };
      if (!body.data?.name || body.data.members?.length !== 1 || body.data.members[0].agent_name !== name) {
        throw new Error(`Subscription channel membership did not verify for @${name}`);
      }
      return body.data.name;
    }
    const detail = (await response.json().catch(() => undefined)) as
      | { error?: { code?: unknown } }
      | undefined;
    lastCode = subscriptionChannelErrorCode(detail);
    lastRetryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), Date.now());
    const typedBusy = response.status === 429 && lastCode === SUBSCRIPTION_CHANNEL_BUSY_CODE;
    const delayMs = lastRetryAfterMs ?? SUBSCRIPTION_CHANNEL_FALLBACK_RETRY_MS;
    const willRetry =
      typedBusy && attempt < SUBSCRIPTION_CHANNEL_MAX_ATTEMPTS && Date.now() + delayMs < deadlineMs;
    // Bounded, secret-free evidence for the next live run (stderr, non-OK only).
    console.error(
      '[integration] subscription-channel response',
      JSON.stringify({
        attempt,
        status: response.status,
        code: lastCode,
        retryAfterMs: lastRetryAfterMs,
        willRetry,
      })
    );
    if (!willRetry) {
      throw subscriptionChannelFailure(
        name,
        lastStatus,
        lastCode,
        lastRetryAfterMs,
        typedBusy && Date.now() + delayMs >= deadlineMs
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}
