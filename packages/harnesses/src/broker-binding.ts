import type { AgentRelay } from '@agent-relay/sdk';
import { BrokerDriver } from '@agent-relay/harness-driver';

/**
 * One {@link BrokerDriver} per `AgentRelay` instance. The first
 * `create({ relay })` call starts a broker bound to the relay's workspace; every
 * later call for the same relay reuses it, so all harness agents share a single
 * broker.
 */
const driversByRelay = new WeakMap<AgentRelay, BrokerDriver>();

/**
 * Resolve the shared {@link BrokerDriver} that spawns harness agents into
 * `relay`'s workspace.
 *
 * The broker joins the workspace through its `RELAY_API_KEY` environment
 * variable, so the relay must already own a workspace key.
 *
 * @param relay - The workspace-bound SDK client agents should join.
 * @returns The cached driver for this relay, creating one on first use.
 */
export function getHarnessDriver(relay: AgentRelay): BrokerDriver {
  const existing = driversByRelay.get(relay);
  if (existing) return existing;

  const workspaceKey = relay.workspaceKey;
  if (!workspaceKey) {
    throw new Error(
      'create({ relay }) needs a workspace. Create one with AgentRelay.createWorkspace(...) or ' +
        'construct AgentRelay with a workspaceKey before spawning harness agents.'
    );
  }

  const driver = new BrokerDriver({ env: { RELAY_API_KEY: workspaceKey } });
  driversByRelay.set(relay, driver);
  return driver;
}
