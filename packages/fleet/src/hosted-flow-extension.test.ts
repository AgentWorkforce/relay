import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetActionContext, FleetCapability } from './index.js';
import {
  HOSTED_FLOW_EXTENSION_CAPABILITY,
  HOSTED_FLOW_EXTENSION_RECONCILE_CAPABILITY,
  hostedFlowExtensionInputSha256,
  inspectHostedFlowExtensionReadiness,
  prepareHostedFlowExtensionCapabilities,
  type HostedFlowExtensionInput,
  type HostedFlowExtensionProviderOptions,
  type HostedFlowExtensionReceipt,
  type HostedFlowExtensionRunner,
} from './hosted-flow-extension.js';

const SHA_1 = '1'.repeat(40);
const SHA_256 = '2'.repeat(64);
const MANIFEST_SHA_256 = '3'.repeat(64);
const ATTESTATION_SHA_256 = '4'.repeat(64);
const PROVIDER_ID = '0199a4de-d383-7d45-97b8-3e5d7cab166d';
const LISTENER_AUTHORITY_ID = 'cloud-flow-listeners:v1';
const RECEIPT_JOURNAL_ID = '0199a4de-d383-7d45-97b8-3e5d7cab166e';

describe('hosted Flow extension provider', () => {
  let directory: string;
  let flowPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'relay-hosted-flow-'));
    flowPath = join(directory, 'babysitter.flow.json');
    await writeFile(flowPath, '{}\n', 'utf8');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reports structured readiness and refuses to advertise partial availability', async () => {
    const options = providerOptions(successRunner(), vi.fn(), {
      bubblewrapPath: join(directory, 'missing-bwrap'),
      nativeExistingSessionReadiness: async () => false,
    });

    await expect(inspectHostedFlowExtensionReadiness(options)).resolves.toEqual({
      hostedExecution: { ready: false, missing: ['bubblewrap'] },
      nativeExistingSession: { ready: false },
    });
    await expect(prepareHostedFlowExtensionCapabilities(options)).rejects.toThrow(/hosted_flow_unavailable/);
  });

  it('runs one pinned capability, queues exact native delivery, and durably replays', async () => {
    const runner = successRunner();
    const fetch = queuedFetch('native-receipt-1');
    const options = providerOptions(runner, fetch);
    const capabilities = await prepareHostedFlowExtensionCapabilities(options);

    const result = await execute(capabilities, input(), context());
    expect(result).toMatchObject({
      status: 'completed',
      capabilityCalls: 1,
      nativeDeliveryReceiptId: 'native-receipt-1',
      eventEnvelopeSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).toMatchObject({
      providerBindingId: PROVIDER_ID,
      listenerAuthorityId: LISTENER_AUTHORITY_ID,
      receiptJournalId: RECEIPT_JOURNAL_ID,
    });
    expect(Object.keys(result)).toHaveLength(30);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const nativeRequest = JSON.parse(
      String((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body)
    ) as Record<string, unknown>;
    expect(nativeRequest.target).toEqual({
      relayWorkspaceId: 'workspace-relay-1',
      nodeId: 'node-1',
      agentId: 'agt_resident',
      workerGeneration: '123e4567-e89b-12d3-a456-426614174000',
    });

    const restartedRunner = successRunner();
    const restartedFetch = queuedFetch('should-not-be-used');
    const restarted = await prepareHostedFlowExtensionCapabilities(
      providerOptions(restartedRunner, restartedFetch)
    );
    await expect(execute(restarted, input(), context())).resolves.toEqual(result);
    expect(restartedRunner).not.toHaveBeenCalled();
    expect(restartedFetch).not.toHaveBeenCalled();

    const reconcile = restarted[HOSTED_FLOW_EXTENSION_RECONCILE_CAPABILITY] as FleetCapability;
    await expect(
      reconcile.handler(
        {
          deliveryId: input().deliveryId,
          inputSha256: hostedFlowExtensionInputSha256(input()),
          listenerAgentId: input().listenerAgentId,
          providerBinding: input().providerBinding,
        },
        context()
      )
    ).resolves.toEqual(result);
  });

  it('publishes one immutable provider and receipt-journal binding on both actions', async () => {
    const capabilities = await prepareHostedFlowExtensionCapabilities(
      providerOptions(successRunner(), queuedFetch('native-receipt-1'))
    );
    const executeCapability = capabilities[HOSTED_FLOW_EXTENSION_CAPABILITY] as FleetCapability;
    const reconcileCapability = capabilities[HOSTED_FLOW_EXTENSION_RECONCILE_CAPABILITY] as FleetCapability;
    const binding = {
      providerBindingId: PROVIDER_ID,
      listenerAuthorityId: LISTENER_AUTHORITY_ID,
      receiptJournalId: RECEIPT_JOURNAL_ID,
    };
    expect(executeCapability.metadata).toMatchObject(binding);
    expect(reconcileCapability.metadata).toMatchObject(binding);
    expect(executeCapability.metadata?.['relay.action-caller']).toBe('v1');
    expect(reconcileCapability.metadata?.['relay.action-caller']).toBe('v1');
  });

  it('refuses to attach a different journal identity to existing durable state', async () => {
    await prepareHostedFlowExtensionCapabilities(
      providerOptions(successRunner(), queuedFetch('native-receipt-1'))
    );
    await expect(
      prepareHostedFlowExtensionCapabilities(
        providerOptions(successRunner(), queuedFetch('native-receipt-2'), {
          receiptJournalId: '0199a4de-d383-7d45-97b8-3e5d7cab166f',
        })
      )
    ).rejects.toThrow('hosted_flow_receipt_ledger_invalid');
  });

  it('conflicts when a delivery id is reused for changed authority-bound input', async () => {
    const capabilities = await prepareHostedFlowExtensionCapabilities(
      providerOptions(successRunner(), queuedFetch('native-receipt-1'))
    );
    await execute(capabilities, input(), context());

    const changed = { ...input(), lineageId: 'lineage-changed' };
    changed.nativeDelivery = { ...changed.nativeDelivery, lineageId: 'lineage-changed' };
    await expect(execute(capabilities, changed, context())).rejects.toThrow('hosted_flow_delivery_conflict');
  });

  it('coalesces concurrent exact duplicates into one Flow run and native write', async () => {
    let finish!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finishPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runner = vi.fn<HostedFlowExtensionRunner>(async (options) => {
      const invocation = capabilityInvocation(input());
      await options.babysitterTurn.queue(invocation.request, invocation.authority);
      started();
      await finishPromise;
      return { completionReason: 'success', capabilityCalls: 1 };
    });
    const fetch = queuedFetch('native-receipt-1');
    const capabilities = await prepareHostedFlowExtensionCapabilities(providerOptions(runner, fetch));

    const first = execute(capabilities, input(), context());
    await startedPromise;
    const second = execute(capabilities, input(), context());
    finish();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing or spoofed authenticated caller before running the Flow', async () => {
    const runner = successRunner();
    const capabilities = await prepareHostedFlowExtensionCapabilities(
      providerOptions(runner, queuedFetch('native-receipt-1'))
    );

    await expect(execute(capabilities, input(), context(null))).rejects.toThrow(
      'hosted_flow_caller_unauthorized'
    );
    await expect(execute(capabilities, input(), context('agt_attacker'))).rejects.toThrow(
      'hosted_flow_listener_mismatch'
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it('supports independently provisioned listeners through the provider authority policy', async () => {
    const listenerAgentId = 'agt_second_listener';
    const runner = vi.fn<HostedFlowExtensionRunner>(async (options) => {
      const invocation = capabilityInvocation(input({ listenerAgentId }));
      await options.babysitterTurn.queue(invocation.request, invocation.authority);
      return { completionReason: 'success', capabilityCalls: 1 };
    });
    const capabilities = await prepareHostedFlowExtensionCapabilities(
      providerOptions(runner, queuedFetch('native-receipt-2'), {
        listenerAuthority: {
          id: LISTENER_AUTHORITY_ID,
          authorize: async (agentId) => ['agt_listener', listenerAgentId].includes(agentId),
        },
      })
    );

    await expect(
      execute(capabilities, input({ listenerAgentId }), context(listenerAgentId))
    ).resolves.toMatchObject({ listenerAgentId });
  });

  it('rejects provider binding substitution and cross-listener reconciliation', async () => {
    const capabilities = await prepareHostedFlowExtensionCapabilities(
      providerOptions(successRunner(), queuedFetch('native-receipt-1'), {
        listenerAuthority: {
          id: LISTENER_AUTHORITY_ID,
          authorize: async (agentId) => ['agt_listener', 'agt_second_listener'].includes(agentId),
        },
      })
    );
    const exactInput = input();
    await execute(capabilities, exactInput, context());
    await expect(
      execute(
        capabilities,
        {
          ...input(),
          providerBinding: {
            ...input().providerBinding,
            receiptJournalId: '0199a4de-d383-7d45-97b8-3e5d7cab166f',
          },
        },
        context()
      )
    ).rejects.toThrow('hosted_flow_provider_binding_mismatch');

    const reconcile = capabilities[HOSTED_FLOW_EXTENSION_RECONCILE_CAPABILITY] as FleetCapability;
    await expect(
      reconcile.handler(
        {
          deliveryId: exactInput.deliveryId,
          inputSha256: hostedFlowExtensionInputSha256(exactInput),
          listenerAgentId: 'agt_second_listener',
          providerBinding: exactInput.providerBinding,
        },
        context('agt_second_listener')
      )
    ).rejects.toThrow('hosted_flow_delivery_caller_conflict');
  });

  it('fails closed when the Flow calls its sole capability twice', async () => {
    const runner = vi.fn<HostedFlowExtensionRunner>(async (options) => {
      const invocation = capabilityInvocation(input());
      await options.babysitterTurn.queue(invocation.request, invocation.authority);
      await options.babysitterTurn.queue(invocation.request, invocation.authority);
      return { completionReason: 'success', capabilityCalls: 2 };
    });
    const capabilities = await prepareHostedFlowExtensionCapabilities(
      providerOptions(runner, queuedFetch('native-receipt-1'))
    );

    await expect(execute(capabilities, input(), context())).rejects.toThrow(
      'hosted_flow_capability_called_more_than_once'
    );
  });

  it('never completes an in-doubt native delivery and safely retries the reservation', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: 'in_doubt', code: 'write_uncertain' }, 503))
      .mockResolvedValueOnce(
        jsonResponse({ status: 'duplicate', state: 'queued', receiptId: 'native-receipt-1' })
      );
    const runner = successRunner();
    const capabilities = await prepareHostedFlowExtensionCapabilities(providerOptions(runner, fetch));

    await expect(execute(capabilities, input(), context())).rejects.toThrow(
      'hosted_flow_native_delivery_unconfirmed'
    );
    await expect(execute(capabilities, input(), context())).resolves.toMatchObject({
      status: 'completed',
      nativeDeliveryReceiptId: 'native-receipt-1',
    });
    expect(runner).toHaveBeenCalledTimes(2);
  });

  function providerOptions(
    runner: HostedFlowExtensionRunner,
    fetch: typeof globalThis.fetch,
    overrides: Partial<HostedFlowExtensionProviderOptions> = {}
  ): HostedFlowExtensionProviderOptions {
    return {
      nodeId: 'node-1',
      relayWorkspaceId: 'workspace-relay-1',
      providerBindingId: PROVIDER_ID,
      listenerAuthority: {
        id: LISTENER_AUTHORITY_ID,
        authorize: async (agentId) => agentId === 'agt_listener',
      },
      receiptJournalId: RECEIPT_JOURNAL_ID,
      runtimeAttestationSha256: ATTESTATION_SHA_256,
      flowPath,
      artifact: {
        ref: 'github:AgentWorkforce/flows@commit#extensions/babysitter',
        digest: SHA_256,
        manifestSha256: MANIFEST_SHA_256,
      },
      stateDirectory: directory,
      brokerBaseUrl: 'http://127.0.0.1:8787',
      brokerApiKey: 'secret',
      runner,
      nativeExistingSessionReadiness: async () => true,
      bubblewrapPath: '/bin/sh',
      nodePath: process.execPath,
      prlimitPath: '/bin/sh',
      fetch,
      ...overrides,
    };
  }
});

function input(overrides: Partial<HostedFlowExtensionInput> = {}): HostedFlowExtensionInput {
  return {
    deliveryId: 'delivery-1',
    workspaceId: 'cloud-workspace-1',
    listenerAgentId: 'agt_listener',
    providerBinding: {
      providerBindingId: PROVIDER_ID,
      listenerAuthorityId: LISTENER_AUTHORITY_ID,
      receiptJournalId: RECEIPT_JOURNAL_ID,
    },
    eventEnvelope: { action: 'labeled', label: 'babysit' },
    lineageId: 'lineage-1',
    owner: 'AgentWorkforce',
    repository: 'relay',
    pullRequestNumber: 1851,
    headSha: SHA_1,
    target: {
      relayWorkspaceId: 'workspace-relay-1',
      nodeId: 'node-1',
      agentId: 'agt_resident',
      relayAgentName: 'resident',
      sessionId: 'session-1',
      workerGeneration: '123e4567-e89b-12d3-a456-426614174000',
      flowCapability: HOSTED_FLOW_EXTENSION_CAPABILITY,
      flowCapabilityVersion: 1,
      nativeCapability: 'relay:native-existing-session:v1',
      nativeCapabilityVersion: 1,
      runtimeAttestationSha256: ATTESTATION_SHA_256,
    },
    dispatch: { provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1' },
    input: {
      event: { provider: 'github', eventType: 'pull_request.labeled', deliveryId: 'delivery-1' },
      pullRequest: {
        host: 'github',
        owner: 'AgentWorkforce',
        repo: 'relay',
        number: 1851,
        headSha: SHA_1,
      },
    },
    nativeDelivery: {
      relayAgentName: 'resident',
      sessionId: 'session-1',
      deliveryId: 'delivery-1',
      lineageId: 'lineage-1',
      headSha: SHA_1,
      message: 'Continue the Babysitter turn.',
    },
    ...overrides,
  };
}

function capabilityInvocation(value: HostedFlowExtensionInput) {
  return {
    request: {
      delivery: {
        deliveryId: value.deliveryId,
        provider: 'github',
        eventType: value.dispatch.eventType,
        pullRequest: {
          owner: value.owner,
          repository: value.repository,
          number: value.pullRequestNumber,
        },
      },
    },
    authority: {
      dispatch: value.dispatch,
      extension: {
        name: 'babysitter',
        ref: 'github:AgentWorkforce/flows@commit#extensions/babysitter',
        digest: SHA_256,
        manifestSha256: MANIFEST_SHA_256,
      },
    },
  };
}

function successRunner() {
  return vi.fn<HostedFlowExtensionRunner>(async (options) => {
    const invocation = capabilityInvocation(input());
    await options.babysitterTurn.queue(invocation.request, invocation.authority);
    return { completionReason: 'success', capabilityCalls: 1 };
  });
}

function queuedFetch(receiptId: string) {
  return vi.fn<typeof globalThis.fetch>(async () =>
    jsonResponse({ status: 'queued', state: 'queued', receiptId })
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function execute(
  capabilities: Record<string, unknown>,
  value: HostedFlowExtensionInput,
  actionContext: FleetActionContext
): Promise<HostedFlowExtensionReceipt> {
  const capability = capabilities[HOSTED_FLOW_EXTENSION_CAPABILITY] as FleetCapability<
    HostedFlowExtensionInput,
    HostedFlowExtensionReceipt
  >;
  return capability.handler(value, actionContext);
}

function context(callerAgentId: string | null = 'agt_listener'): FleetActionContext {
  return {
    node: { name: 'node-1', capabilities: [HOSTED_FLOW_EXTENSION_CAPABILITY] },
    relay: { sendMessage: vi.fn() },
    callerAgentId: callerAgentId ?? undefined,
    callerAgentName: callerAgentId ? 'listener' : undefined,
    spawnAgent: vi.fn(),
  };
}
