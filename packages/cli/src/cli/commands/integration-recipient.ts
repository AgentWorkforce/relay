import { UNBOUND_CREDENTIAL_ORIGIN } from '../lib/relaycast-origin-binding.js';
import { resolveWorkspaceTransport, type SdkClientOptions } from '../lib/sdk-client.js';

/** Owner-authorized endpoint joins the exact identity without rotating its agent token. */
export async function resolveSubscriptionAgentChannel(
  name: string,
  options: SdkClientOptions
): Promise<string> {
  // One resolution, so the key sent is exactly the one whose server was checked.
  const transport = resolveWorkspaceTransport(options);
  const response = await fetch(
    new URL(
      `/v1/agents/${encodeURIComponent(name)}/subscription-channel`,
      transport.baseUrl ?? UNBOUND_CREDENTIAL_ORIGIN
    ),
    {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${transport.workspaceKey}` },
    }
  );
  if (!response.ok) {
    const detail = (await response.json().catch(() => undefined)) as
      { error?: { code?: unknown } } | undefined;
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
