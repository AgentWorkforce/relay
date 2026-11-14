import { describe, expect, it } from 'vitest';

import * as bridge from './index.js';
import type {
  CallerFileDescriptor,
  CoreClient,
  HelloResult,
  SpawnInvokeParams,
  SpawnReleaseParams,
  SpawnStatusParams,
} from './index.js';

/**
 * Exact optional package surface consumed by Flows at
 * AgentWorkforce/flows@7897907659ce11da0f8fa67015bb7a9426234f4e.
 * Keep this mirror structural: Flows loads the package dynamically.
 */
interface FlowCoreBridgeClient {
  readonly hello: {
    bridge_version: number;
    daemon_version: string;
    pid: number;
    methods: string[];
    topics: Array<'status' | 'activity' | 'shutdown' | 'invalidated' | 'notify' | 'sign_in'>;
  };
  close(): void;
}

interface FlowCallerDescriptor {
  readonly schema: 'agent-relay-service-caller/2';
  readonly schemaVersion: 2;
  readonly auth: unknown;
  readonly callerId: string;
  readonly callerName: string;
  readonly publisher: { readonly id: string; readonly name: string };
  readonly workspace: {
    readonly site_url: string;
    readonly base_url: string;
    readonly workspace_id: string;
    readonly relaycast_workspace_id: string;
  };
  readonly account: { readonly user_id: string };
  readonly credential: unknown;
  readonly createdAt: string;
  readonly rotatedAt?: string;
  readonly expiresAt: string;
  readonly harnesses: readonly string[];
  readonly directoryScope: readonly string[];
  readonly ownsOnly: boolean;
  readonly socket: string;
  readonly inbox: {
    readonly transport: string;
    readonly open: string;
    readonly next: string;
    readonly ack: string;
    readonly fail: string;
    readonly close: string;
    readonly disconnect: string;
  };
  readonly desktopVersion: string;
}

interface FlowCoreTarget {
  id: string;
  name: string;
  live: boolean;
  handlers_live: boolean;
  stale: boolean;
  capabilities: string[];
  active_agents: number;
  reserved_agents: number;
  max_agents: number;
}

interface FlowCoreInvocation {
  id: string;
  agent_id: string | null;
  status: string;
  node_id: string | null;
  name: string | null;
  spawned: boolean;
  ready: boolean;
  released: boolean;
  task_unconfirmed: boolean;
  error_code: string | null;
}

interface FlowSpawnInvokeParams {
  caller_name?: string;
  node_id: string;
  node_name: string;
  name: string;
  harness: string;
  task: string;
  directory: string;
  idempotency_key: string;
}

interface FlowSpawnStatusParams {
  caller_name?: string;
  action: 'spawn' | 'release';
  invocation_id: string;
}

interface FlowSpawnReleaseParams {
  caller_name?: string;
  node_id: string;
  node_name: string;
  name: string;
  expected_agent_id: string;
  idempotency_key: string;
}

interface FlowCoreInboxDelivery {
  item_id: string;
  message_id: string;
  sender: { id: string; name: string };
  text?: string;
  failure?: { code: 'result_too_large' | 'result_write_failed'; bytes: number; limit: number };
  invocation_id: string;
  sent_at: string;
}

interface FlowCoreBridgeApi<TClient extends FlowCoreBridgeClient, TDescriptor extends FlowCallerDescriptor> {
  connectCore: (options?: { socket?: string; signal?: AbortSignal }) => Promise<TClient>;
  readCallerDescriptor: (path: string) => Promise<TDescriptor>;
  authenticate: (
    client: TClient,
    credential: TDescriptor['credential'],
    options?: { signal?: AbortSignal }
  ) => Promise<unknown>;
  requireServiceCallerMethods: (client: TClient) => void;
  assertServiceCallerIdentity: (
    descriptor: TDescriptor,
    identity: Awaited<ReturnType<FlowCoreBridgeApi<TClient, TDescriptor>['serviceCallerIdentity']>>
  ) => void;
  serviceCallerIdentity: (
    client: TClient,
    options?: { signal?: AbortSignal }
  ) => Promise<{
    publisher: { id: string; name: string };
    node: { id: string; name: string };
    base_url: string;
    workspace_id: string;
    relaycast_workspace_id: string;
  }>;
  spawnTargets: (
    client: TClient,
    options?: { signal?: AbortSignal }
  ) => Promise<{ targets: FlowCoreTarget[] }>;
  spawnInvoke: (
    client: TClient,
    params: FlowSpawnInvokeParams,
    options?: { signal?: AbortSignal; actionTimeoutMs?: number }
  ) => Promise<FlowCoreInvocation>;
  spawnStatus: (
    client: TClient,
    params: FlowSpawnStatusParams,
    options?: { signal?: AbortSignal }
  ) => Promise<FlowCoreInvocation>;
  spawnRelease: (
    client: TClient,
    params: FlowSpawnReleaseParams,
    options?: { signal?: AbortSignal; actionTimeoutMs?: number }
  ) => Promise<FlowCoreInvocation>;
  serviceCallerInboxOpen: (
    client: TClient,
    invocationId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<{ iterator_id: string }>;
  serviceCallerInboxNext: (
    client: TClient,
    iteratorId: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal }
  ) => Promise<{ delivery: FlowCoreInboxDelivery | null }>;
  serviceCallerInboxAck: (
    client: TClient,
    itemId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<unknown>;
  serviceCallerInboxFail: (
    client: TClient,
    itemId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<unknown>;
  serviceCallerInboxClose: (
    client: TClient,
    iteratorId: string,
    options?: { signal?: AbortSignal }
  ) => Promise<unknown>;
  serviceCallerDisconnect: (client: TClient, options?: { signal?: AbortSignal }) => Promise<unknown>;
}

const REQUIRED_FUNCTIONS = [
  'connectCore',
  'readCallerDescriptor',
  'authenticate',
  'requireServiceCallerMethods',
  'assertServiceCallerIdentity',
  'serviceCallerIdentity',
  'spawnTargets',
  'spawnInvoke',
  'spawnStatus',
  'spawnRelease',
  'serviceCallerInboxOpen',
  'serviceCallerInboxNext',
  'serviceCallerInboxAck',
  'serviceCallerInboxFail',
  'serviceCallerInboxClose',
  'serviceCallerDisconnect',
] as const satisfies ReadonlyArray<keyof FlowCoreBridgeApi<CoreClient, CallerFileDescriptor>>;

// Each assignment is deliberate: a missing export or incompatible signature
// must fail TypeScript before a package reaches Flows' dynamic import.
const STRUCTURAL_CONTRACT: FlowCoreBridgeApi<CoreClient, CallerFileDescriptor> = {
  connectCore: bridge.connectCore,
  readCallerDescriptor: bridge.readCallerDescriptor,
  authenticate: bridge.authenticate,
  requireServiceCallerMethods: bridge.requireServiceCallerMethods,
  assertServiceCallerIdentity: bridge.assertServiceCallerIdentity,
  serviceCallerIdentity: bridge.serviceCallerIdentity,
  spawnTargets: bridge.spawnTargets,
  spawnInvoke: bridge.spawnInvoke,
  spawnStatus: bridge.spawnStatus,
  spawnRelease: bridge.spawnRelease,
  serviceCallerInboxOpen: bridge.serviceCallerInboxOpen,
  serviceCallerInboxNext: bridge.serviceCallerInboxNext,
  serviceCallerInboxAck: bridge.serviceCallerInboxAck,
  serviceCallerInboxFail: bridge.serviceCallerInboxFail,
  serviceCallerInboxClose: bridge.serviceCallerInboxClose,
  serviceCallerDisconnect: bridge.serviceCallerDisconnect,
};

// The copied Flows shapes are intentionally less specific than the package's
// correlated client and credential types. Function-valued properties make
// strictFunctionTypes reject an implementation that narrows either input.
// @ts-expect-error authenticate requires the richer CoreClient and CallerCredential.
const REJECTED_NARROW_AUTHENTICATE: FlowCoreBridgeApi<
  FlowCoreBridgeClient,
  FlowCallerDescriptor
>['authenticate'] = bridge.authenticate;

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type _ClientAssignable = Assert<CoreClient extends FlowCoreBridgeClient ? true : false>;
type _HelloExact = Assert<Equal<HelloResult, FlowCoreBridgeClient['hello']>>;
type _InvokeParamsExact = Assert<Equal<SpawnInvokeParams, FlowSpawnInvokeParams>>;
type _StatusParamsExact = Assert<Equal<SpawnStatusParams, FlowSpawnStatusParams>>;
type _ReleaseParamsExact = Assert<Equal<SpawnReleaseParams, FlowSpawnReleaseParams>>;

void (null as unknown as [
  _ClientAssignable,
  _HelloExact,
  _InvokeParamsExact,
  _StatusParamsExact,
  _ReleaseParamsExact,
]);
void REJECTED_NARROW_AUTHENTICATE;

describe('Flows schema-v2 public surface', () => {
  it('exports every function the optional local adapter loads', () => {
    expect(REQUIRED_FUNCTIONS).toHaveLength(16);
    for (const name of REQUIRED_FUNCTIONS) {
      expect(STRUCTURAL_CONTRACT[name], name).toBeTypeOf('function');
    }
  });
});
