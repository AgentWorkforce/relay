import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { FleetActionContext, FleetActionDefinition, FleetCapabilityValue } from './index.js';

export const HOSTED_FLOW_EXTENSION_CAPABILITY = 'relay:hosted-flow-extension:v1';
export const HOSTED_FLOW_EXTENSION_RECONCILE_CAPABILITY = 'relay:hosted-flow-extension-reconcile:v1';
export const NATIVE_EXISTING_SESSION_CAPABILITY = 'relay:native-existing-session:v1';

const SHA_1 = /^[a-f0-9]{40}$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[^\x00-\x1f\x7f]{1,512}$/u;
const RECEIPT_FILENAME = 'hosted-flow-extension-receipts.json';
const uuidSchema = z.string().uuid();

const providerBindingSchema = z
  .object({
    providerBindingId: uuidSchema,
    listenerAuthorityId: z.string().regex(IDENTIFIER),
    receiptJournalId: uuidSchema,
  })
  .strict();

const targetSchema = z
  .object({
    relayWorkspaceId: z.string().regex(IDENTIFIER),
    nodeId: z.string().regex(IDENTIFIER),
    agentId: z.string().regex(IDENTIFIER),
    relayAgentName: z.string().regex(IDENTIFIER),
    sessionId: z.string().regex(IDENTIFIER),
    workerGeneration: z.string().uuid(),
    flowCapability: z.literal(HOSTED_FLOW_EXTENSION_CAPABILITY),
    flowCapabilityVersion: z.literal(1),
    nativeCapability: z.literal(NATIVE_EXISTING_SESSION_CAPABILITY),
    nativeCapabilityVersion: z.literal(1),
    runtimeAttestationSha256: z.string().regex(SHA_256),
  })
  .strict();

const hostedInputSchema = z
  .object({
    deliveryId: z.string().regex(IDENTIFIER),
    workspaceId: z.string().regex(IDENTIFIER),
    listenerAgentId: z.string().regex(IDENTIFIER),
    providerBinding: providerBindingSchema,
    eventEnvelope: z.record(z.string(), z.unknown()),
    lineageId: z.string().regex(IDENTIFIER),
    owner: z.string().regex(IDENTIFIER),
    repository: z.string().regex(IDENTIFIER),
    pullRequestNumber: z.number().int().positive(),
    headSha: z.string().regex(SHA_1),
    target: targetSchema,
    dispatch: z
      .object({
        provider: z.literal('github'),
        eventType: z.string().regex(IDENTIFIER),
        deliveryId: z.string().regex(IDENTIFIER),
      })
      .strict(),
    input: z
      .object({
        event: z
          .object({
            provider: z.literal('github'),
            eventType: z.string().regex(IDENTIFIER),
            deliveryId: z.string().regex(IDENTIFIER),
          })
          .strict(),
        pullRequest: z
          .object({
            host: z.literal('github'),
            owner: z.string().regex(IDENTIFIER),
            repo: z.string().regex(IDENTIFIER),
            number: z.number().int().positive(),
            headSha: z.string().regex(SHA_1),
          })
          .strict(),
      })
      .strict(),
    nativeDelivery: z
      .object({
        relayAgentName: z.string().regex(IDENTIFIER),
        sessionId: z.string().regex(IDENTIFIER),
        deliveryId: z.string().regex(IDENTIFIER),
        lineageId: z.string().regex(IDENTIFIER),
        headSha: z.string().regex(SHA_1),
        message: z
          .string()
          .min(1)
          .max(128 * 1024),
      })
      .strict(),
  })
  .strict();

const reconcileSchema = z
  .object({
    deliveryId: z.string().regex(IDENTIFIER),
    inputSha256: z.string().regex(SHA_256),
    listenerAgentId: z.string().regex(IDENTIFIER),
    providerBinding: providerBindingSchema,
  })
  .strict();

export type HostedFlowExtensionInput = z.infer<typeof hostedInputSchema>;
export type HostedFlowExtensionTarget = z.infer<typeof targetSchema>;
export type HostedFlowExtensionProviderBinding = z.infer<typeof providerBindingSchema>;
export type HostedFlowExtensionReconcileInput = z.infer<typeof reconcileSchema>;

export interface HostedFlowExtensionReceipt {
  readonly status: 'completed';
  readonly completionReason: 'success';
  readonly capabilityCalls: 1;
  readonly runId: string;
  readonly deliveryId: string;
  readonly workspaceId: string;
  readonly listenerAgentId: string;
  readonly providerBindingId: string;
  readonly listenerAuthorityId: string;
  readonly receiptJournalId: string;
  readonly eventEnvelopeSha256: string;
  readonly artifactRef: string;
  readonly artifactDigest: string;
  readonly manifestSha256: string;
  readonly lineageId: string;
  readonly owner: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly relayWorkspaceId: string;
  readonly nodeId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly workerGeneration: string;
  readonly flowCapability: typeof HOSTED_FLOW_EXTENSION_CAPABILITY;
  readonly flowCapabilityVersion: 1;
  readonly nativeCapability: typeof NATIVE_EXISTING_SESSION_CAPABILITY;
  readonly nativeCapabilityVersion: 1;
  readonly runtimeAttestationSha256: string;
  readonly nativeDeliveryReceiptId: string;
}

export interface HostedFlowExtensionRunnerOptions {
  readonly flowPath: string;
  readonly dispatch: HostedFlowExtensionInput['dispatch'];
  readonly input: HostedFlowExtensionInput['input'];
  readonly babysitterTurn: {
    queue(request: unknown, authority: unknown): Promise<unknown>;
  };
  readonly bubblewrapPath: string;
  readonly nodePath: string;
  readonly prlimitPath: string;
}

export type HostedFlowExtensionRunner = (
  options: HostedFlowExtensionRunnerOptions
) => Promise<{ readonly completionReason: string; readonly capabilityCalls: number }>;

export interface HostedFlowExtensionProviderOptions {
  readonly nodeId: string;
  readonly relayWorkspaceId: string;
  /** Stable identity of this logical provider deployment. */
  readonly providerBindingId: string;
  /** Stable identity of the policy that authorizes Cloud Flow listeners. */
  readonly listenerAuthority: Readonly<{
    id: string;
    authorize(agentId: string): boolean | Promise<boolean>;
  }>;
  /** Stable identity of the durable receipt journal shared by execute and reconcile. */
  readonly receiptJournalId: string;
  readonly runtimeAttestationSha256: string;
  readonly flowPath: string;
  readonly artifact: Readonly<{
    ref: string;
    digest: string;
    manifestSha256: string;
  }>;
  readonly stateDirectory: string;
  readonly brokerBaseUrl: string;
  readonly brokerApiKey: string;
  readonly runner: HostedFlowExtensionRunner;
  /** Probes the broker's exact native-existing-session route and authority prerequisites. */
  readonly nativeExistingSessionReadiness: () => Promise<boolean>;
  readonly bubblewrapPath?: string;
  readonly nodePath?: string;
  readonly prlimitPath?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HostedFlowExtensionReadiness {
  readonly hostedExecution: {
    readonly ready: boolean;
    readonly missing: readonly string[];
  };
  readonly nativeExistingSession: {
    readonly ready: boolean;
  };
}

type ReceiptEntry =
  | { inputSha256: string; listenerAgentId: string; runId: string; state: 'reserved' }
  | {
      inputSha256: string;
      listenerAgentId: string;
      runId: string;
      state: 'completed';
      receipt: HostedFlowExtensionReceipt;
    };

type ReceiptLedger = {
  version: 1;
  receiptJournalId: string;
  deliveries: Record<string, ReceiptEntry>;
};

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function assertExactInput(input: HostedFlowExtensionInput): void {
  if (
    input.deliveryId !== input.dispatch.deliveryId ||
    input.deliveryId !== input.input.event.deliveryId ||
    input.deliveryId !== input.nativeDelivery.deliveryId ||
    input.dispatch.eventType !== input.input.event.eventType ||
    input.owner.toLowerCase() !== input.input.pullRequest.owner.toLowerCase() ||
    input.repository.toLowerCase() !== input.input.pullRequest.repo.toLowerCase() ||
    input.pullRequestNumber !== input.input.pullRequest.number ||
    input.headSha !== input.input.pullRequest.headSha ||
    input.headSha !== input.nativeDelivery.headSha ||
    input.lineageId !== input.nativeDelivery.lineageId ||
    input.target.relayAgentName !== input.nativeDelivery.relayAgentName ||
    input.target.sessionId !== input.nativeDelivery.sessionId
  ) {
    throw new Error('hosted_flow_input_identity_mismatch');
  }
}

async function assertCallerAuthority(
  listenerAgentId: string,
  providerBinding: HostedFlowExtensionInput['providerBinding'],
  context: FleetActionContext,
  options: HostedFlowExtensionProviderOptions
): Promise<void> {
  if (!context.callerAgentId) {
    throw new Error('hosted_flow_caller_unauthorized');
  }
  if (listenerAgentId !== context.callerAgentId) {
    throw new Error('hosted_flow_listener_mismatch');
  }
  if (
    providerBinding.providerBindingId !== options.providerBindingId ||
    providerBinding.listenerAuthorityId !== options.listenerAuthority.id ||
    providerBinding.receiptJournalId !== options.receiptJournalId
  ) {
    throw new Error('hosted_flow_provider_binding_mismatch');
  }
  let authorized = false;
  try {
    authorized = await options.listenerAuthority.authorize(context.callerAgentId);
  } catch {
    authorized = false;
  }
  if (!authorized) {
    throw new Error('hosted_flow_caller_unauthorized');
  }
}

async function assertExecutionAuthority(
  input: HostedFlowExtensionInput,
  context: FleetActionContext,
  options: HostedFlowExtensionProviderOptions
): Promise<void> {
  await assertCallerAuthority(input.listenerAgentId, input.providerBinding, context, options);
  if (
    input.target.nodeId !== options.nodeId ||
    input.target.relayWorkspaceId !== options.relayWorkspaceId ||
    input.target.runtimeAttestationSha256 !== options.runtimeAttestationSha256
  ) {
    throw new Error('hosted_flow_target_unauthorized');
  }
}

async function durableWrite(path: string, value: ReceiptLedger): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readLedger(path: string, receiptJournalId: string): Promise<ReceiptLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ReceiptLedger;
    if (
      parsed.version !== 1 ||
      parsed.receiptJournalId !== receiptJournalId ||
      !parsed.deliveries ||
      typeof parsed.deliveries !== 'object'
    ) {
      throw new Error('hosted_flow_receipt_ledger_invalid');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, receiptJournalId, deliveries: {} };
    }
    throw error;
  }
}

class DurableReceiptLedger {
  private readonly path: string;
  private readonly lockPath: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    directory: string,
    private readonly receiptJournalId: string
  ) {
    this.path = join(directory, RECEIPT_FILENAME);
    this.lockPath = `${this.path}.lock`;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.locked(async (ledger) => {
      await durableWrite(this.path, ledger);
    });
  }

  private async acquireLock() {
    try {
      return await open(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number.parseInt((await readFile(this.lockPath, 'utf8')).trim(), 10);
      if (!Number.isSafeInteger(owner) || owner <= 0) {
        throw new Error('hosted_flow_receipt_ledger_busy');
      }
      try {
        process.kill(owner, 0);
        throw new Error('hosted_flow_receipt_ledger_busy');
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== 'ESRCH') throw ownerError;
      }
      await rm(this.lockPath, { force: true });
      return open(this.lockPath, 'wx', 0o600);
    }
  }

  private async locked<T>(operation: (ledger: ReceiptLedger) => Promise<T>): Promise<T> {
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lock = await this.acquireLock();
      await lock.writeFile(`${process.pid}\n`, 'utf8');
      await lock.sync();
      return await operation(await readLedger(this.path, this.receiptJournalId));
    } finally {
      if (lock) {
        await lock.close();
        await rm(this.lockPath, { force: true });
      }
      release();
    }
  }

  async reserve(
    deliveryId: string,
    inputSha256: string,
    listenerAgentId: string
  ): Promise<{ runId: string; receipt?: HostedFlowExtensionReceipt }> {
    return this.locked(async (ledger) => {
      const existing = ledger.deliveries[deliveryId];
      if (existing && existing.inputSha256 !== inputSha256) {
        throw new Error('hosted_flow_delivery_conflict');
      }
      if (existing && existing.listenerAgentId !== listenerAgentId) {
        throw new Error('hosted_flow_delivery_caller_conflict');
      }
      if (existing?.state === 'completed') {
        return { runId: existing.runId, receipt: existing.receipt };
      }
      if (existing) return { runId: existing.runId };
      const runId = `hfr_${sha256({ deliveryId, inputSha256 })}`;
      ledger.deliveries[deliveryId] = { inputSha256, listenerAgentId, runId, state: 'reserved' };
      await durableWrite(this.path, ledger);
      return { runId };
    });
  }

  async complete(
    deliveryId: string,
    inputSha256: string,
    receipt: HostedFlowExtensionReceipt
  ): Promise<HostedFlowExtensionReceipt> {
    return this.locked(async (ledger) => {
      const existing = ledger.deliveries[deliveryId];
      if (!existing || existing.inputSha256 !== inputSha256) {
        throw new Error('hosted_flow_receipt_reservation_missing');
      }
      if (existing.state === 'completed') return existing.receipt;
      ledger.deliveries[deliveryId] = {
        inputSha256,
        listenerAgentId: existing.listenerAgentId,
        runId: existing.runId,
        state: 'completed',
        receipt,
      };
      await durableWrite(this.path, ledger);
      return receipt;
    });
  }

  async reconcile(
    deliveryId: string,
    inputSha256: string,
    listenerAgentId: string
  ): Promise<{ status: 'pending' } | HostedFlowExtensionReceipt> {
    const ledger = await readLedger(this.path, this.receiptJournalId);
    const existing = ledger.deliveries[deliveryId];
    if (!existing) return { status: 'pending' };
    if (existing.inputSha256 !== inputSha256) throw new Error('hosted_flow_delivery_conflict');
    if (existing.listenerAgentId !== listenerAgentId) {
      throw new Error('hosted_flow_delivery_caller_conflict');
    }
    return existing.state === 'completed' ? existing.receipt : { status: 'pending' };
  }
}

function exactCapabilityRequest(
  request: unknown,
  authority: unknown,
  input: HostedFlowExtensionInput,
  options: HostedFlowExtensionProviderOptions
): void {
  const requestDelivery = (request as { delivery?: unknown })?.delivery as
    | {
        deliveryId?: unknown;
        provider?: unknown;
        eventType?: unknown;
        pullRequest?: { owner?: unknown; repository?: unknown; number?: unknown };
      }
    | undefined;
  const capabilityAuthority = authority as {
    dispatch?: { provider?: unknown; eventType?: unknown; deliveryId?: unknown };
    extension?: {
      name?: unknown;
      ref?: unknown;
      digest?: unknown;
      manifestSha256?: unknown;
    };
  };
  if (
    requestDelivery?.deliveryId !== input.deliveryId ||
    requestDelivery.provider !== 'github' ||
    requestDelivery.eventType !== input.dispatch.eventType ||
    requestDelivery.pullRequest?.owner?.toString().toLowerCase() !== input.owner.toLowerCase() ||
    requestDelivery.pullRequest?.repository?.toString().toLowerCase() !== input.repository.toLowerCase() ||
    requestDelivery.pullRequest?.number !== input.pullRequestNumber ||
    capabilityAuthority.dispatch?.provider !== 'github' ||
    capabilityAuthority.dispatch.eventType !== input.dispatch.eventType ||
    capabilityAuthority.dispatch.deliveryId !== input.deliveryId ||
    capabilityAuthority.extension?.name !== 'babysitter' ||
    capabilityAuthority.extension.ref !== options.artifact.ref ||
    capabilityAuthority.extension.digest !== options.artifact.digest ||
    capabilityAuthority.extension.manifestSha256 !== options.artifact.manifestSha256
  ) {
    throw new Error('hosted_flow_capability_authority_invalid');
  }
}

async function invokeNativeDelivery(
  input: HostedFlowExtensionInput,
  options: HostedFlowExtensionProviderOptions
): Promise<string> {
  const fetch = options.fetch ?? globalThis.fetch;
  const response = await fetch(
    new URL('/api/native-delivery/targeted-existing-session', options.brokerBaseUrl),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': options.brokerApiKey },
      body: JSON.stringify({
        target: {
          relayWorkspaceId: input.target.relayWorkspaceId,
          nodeId: input.target.nodeId,
          agentId: input.target.agentId,
          workerGeneration: input.target.workerGeneration,
        },
        delivery: input.nativeDelivery,
      }),
    }
  );
  const body = (await response.json()) as {
    receiptId?: unknown;
    status?: unknown;
    state?: unknown;
    code?: unknown;
  };
  if (
    !response.ok ||
    typeof body.receiptId !== 'string' ||
    (body.status !== 'queued' && body.status !== 'duplicate') ||
    (body.state !== undefined && body.state !== 'queued')
  ) {
    throw new Error(`hosted_flow_native_delivery_unconfirmed:${String(body.code ?? response.status)}`);
  }
  return body.receiptId;
}

function receipt(
  input: HostedFlowExtensionInput,
  options: HostedFlowExtensionProviderOptions,
  runId: string,
  nativeDeliveryReceiptId: string
): HostedFlowExtensionReceipt {
  return {
    status: 'completed',
    completionReason: 'success',
    capabilityCalls: 1,
    runId,
    deliveryId: input.deliveryId,
    workspaceId: input.workspaceId,
    listenerAgentId: input.listenerAgentId,
    providerBindingId: input.providerBinding.providerBindingId,
    listenerAuthorityId: input.providerBinding.listenerAuthorityId,
    receiptJournalId: input.providerBinding.receiptJournalId,
    eventEnvelopeSha256: sha256(input.eventEnvelope),
    artifactRef: options.artifact.ref,
    artifactDigest: options.artifact.digest,
    manifestSha256: options.artifact.manifestSha256,
    lineageId: input.lineageId,
    owner: input.owner.toLowerCase(),
    repository: input.repository.toLowerCase(),
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
    relayWorkspaceId: input.target.relayWorkspaceId,
    nodeId: input.target.nodeId,
    agentId: input.target.agentId,
    sessionId: input.target.sessionId,
    workerGeneration: input.target.workerGeneration,
    flowCapability: HOSTED_FLOW_EXTENSION_CAPABILITY,
    flowCapabilityVersion: 1,
    nativeCapability: NATIVE_EXISTING_SESSION_CAPABILITY,
    nativeCapabilityVersion: 1,
    runtimeAttestationSha256: input.target.runtimeAttestationSha256,
    nativeDeliveryReceiptId,
  };
}

function validateProviderOptions(options: HostedFlowExtensionProviderOptions): void {
  if (process.platform !== 'linux') throw new Error('hosted_flow_linux_required');
  if (
    !options.listenerAuthority ||
    typeof options.listenerAuthority.id !== 'string' ||
    typeof options.listenerAuthority.authorize !== 'function'
  ) {
    throw new Error('hosted_flow_invalid_listener_authority');
  }
  for (const [field, value] of [
    ['nodeId', options.nodeId],
    ['relayWorkspaceId', options.relayWorkspaceId],
    ['listenerAuthorityId', options.listenerAuthority.id],
  ] as const) {
    if (!IDENTIFIER.test(value) || value.trim() !== value) {
      throw new Error(`hosted_flow_invalid_${field}`);
    }
  }
  if (!uuidSchema.safeParse(options.providerBindingId).success) {
    throw new Error('hosted_flow_invalid_providerBindingId');
  }
  if (!uuidSchema.safeParse(options.receiptJournalId).success) {
    throw new Error('hosted_flow_invalid_receiptJournalId');
  }
  if (!SHA_256.test(options.runtimeAttestationSha256)) {
    throw new Error('hosted_flow_invalid_runtime_attestation');
  }
  if (!SHA_256.test(options.artifact.digest) || !SHA_256.test(options.artifact.manifestSha256)) {
    throw new Error('hosted_flow_invalid_artifact_digest');
  }
  if (!isAbsolute(options.flowPath) || !isAbsolute(options.stateDirectory)) {
    throw new Error('hosted_flow_absolute_paths_required');
  }
  let brokerUrl: URL;
  try {
    brokerUrl = new URL(options.brokerBaseUrl);
  } catch {
    throw new Error('hosted_flow_loopback_broker_required');
  }
  if (
    brokerUrl.protocol !== 'http:' ||
    brokerUrl.hostname !== '127.0.0.1' ||
    brokerUrl.username ||
    brokerUrl.password
  ) {
    throw new Error('hosted_flow_loopback_broker_required');
  }
  if (!options.brokerApiKey || options.brokerApiKey.trim() !== options.brokerApiKey) {
    throw new Error('hosted_flow_broker_api_key_required');
  }
}

export async function inspectHostedFlowExtensionReadiness(
  options: HostedFlowExtensionProviderOptions
): Promise<HostedFlowExtensionReadiness> {
  validateProviderOptions(options);
  const executableChecks = [
    ['bubblewrap', options.bubblewrapPath ?? '/usr/bin/bwrap', fsConstants.X_OK],
    ['node', options.nodePath ?? process.execPath, fsConstants.X_OK],
    ['prlimit', options.prlimitPath ?? '/usr/bin/prlimit', fsConstants.X_OK],
    ['flow', options.flowPath, fsConstants.R_OK],
  ] as const;
  const results = await Promise.allSettled(executableChecks.map(([, path, mode]) => access(path, mode)));
  const missing = results.flatMap((result, index) =>
    result.status === 'rejected' ? [executableChecks[index]![0]] : []
  );
  let nativeReady = false;
  try {
    nativeReady = await options.nativeExistingSessionReadiness();
  } catch {
    nativeReady = false;
  }
  return {
    hostedExecution: { ready: missing.length === 0, missing },
    nativeExistingSession: { ready: nativeReady },
  };
}

/**
 * Build the two hosted Flow actions only after the exact runtime can actually
 * execute them. Callers must not catch readiness failures and advertise a
 * placeholder capability.
 */
export async function prepareHostedFlowExtensionCapabilities(
  options: HostedFlowExtensionProviderOptions
): Promise<Record<string, FleetCapabilityValue>> {
  const readiness = await inspectHostedFlowExtensionReadiness(options);
  if (!readiness.hostedExecution.ready || !readiness.nativeExistingSession.ready) {
    throw new Error(`hosted_flow_unavailable:${JSON.stringify(readiness)}`);
  }
  const bubblewrapPath = options.bubblewrapPath ?? '/usr/bin/bwrap';
  const nodePath = options.nodePath ?? process.execPath;
  const prlimitPath = options.prlimitPath ?? '/usr/bin/prlimit';
  const ledger = new DurableReceiptLedger(options.stateDirectory, options.receiptJournalId);
  await ledger.initialize();
  const inFlight = new Map<string, { inputSha256: string; promise: Promise<HostedFlowExtensionReceipt> }>();

  const execute: FleetActionDefinition<unknown, HostedFlowExtensionReceipt> = {
    kind: 'action',
    input: hostedInputSchema,
    metadata: {
      'relay.action-caller': 'v1',
      contract: 'hostedFlowExtension',
      contractVersion: 1,
      durableReceipts: true,
      reconcileAction: HOSTED_FLOW_EXTENSION_RECONCILE_CAPABILITY,
      runtime: 'node-linux-bwrap',
      readiness: {
        hostedExecution: {
          ready: readiness.hostedExecution.ready,
          missing: [...readiness.hostedExecution.missing],
        },
        nativeExistingSession: { ready: readiness.nativeExistingSession.ready },
      },
      artifactRef: options.artifact.ref,
      artifactDigest: options.artifact.digest,
      manifestSha256: options.artifact.manifestSha256,
      providerBindingId: options.providerBindingId,
      listenerAuthorityId: options.listenerAuthority.id,
      receiptJournalId: options.receiptJournalId,
      relayWorkspaceId: options.relayWorkspaceId,
      nodeId: options.nodeId,
      runtimeAttestationSha256: options.runtimeAttestationSha256,
    },
    handler: async (rawInput, context) => {
      const input = hostedInputSchema.parse(rawInput);
      assertExactInput(input);
      await assertExecutionAuthority(input, context, options);
      const inputSha256 = sha256(input);
      const active = inFlight.get(input.deliveryId);
      if (active) {
        if (active.inputSha256 !== inputSha256) {
          throw new Error('hosted_flow_delivery_conflict');
        }
        return active.promise;
      }
      const promise = (async () => {
        const reserved = await ledger.reserve(input.deliveryId, inputSha256, input.listenerAgentId);
        if (reserved.receipt) return reserved.receipt;

        let nativeReceiptId: string | undefined;
        const result = await options.runner({
          flowPath: options.flowPath,
          dispatch: input.dispatch,
          input: input.input,
          bubblewrapPath,
          nodePath,
          prlimitPath,
          babysitterTurn: {
            queue: async (request, authority) => {
              if (nativeReceiptId) throw new Error('hosted_flow_capability_called_more_than_once');
              exactCapabilityRequest(request, authority, input, options);
              nativeReceiptId = await invokeNativeDelivery(input, options);
              return { receiptId: nativeReceiptId, status: 'queued' };
            },
          },
        });
        if (result.completionReason !== 'success' || result.capabilityCalls !== 1 || !nativeReceiptId) {
          throw new Error('hosted_flow_completion_unconfirmed');
        }
        return ledger.complete(
          input.deliveryId,
          inputSha256,
          receipt(input, options, reserved.runId, nativeReceiptId)
        );
      })();
      inFlight.set(input.deliveryId, { inputSha256, promise });
      try {
        return await promise;
      } finally {
        if (inFlight.get(input.deliveryId)?.promise === promise) {
          inFlight.delete(input.deliveryId);
        }
      }
    },
  };

  const reconcile: FleetActionDefinition<unknown, unknown> = {
    kind: 'action',
    input: reconcileSchema,
    metadata: {
      'relay.action-caller': 'v1',
      contract: 'reconcileHostedFlowExtension',
      contractVersion: 1,
      providerBindingId: options.providerBindingId,
      listenerAuthorityId: options.listenerAuthority.id,
      receiptJournalId: options.receiptJournalId,
      relayWorkspaceId: options.relayWorkspaceId,
      nodeId: options.nodeId,
      runtimeAttestationSha256: options.runtimeAttestationSha256,
    },
    handler: async (rawInput, context) => {
      const input = reconcileSchema.parse(rawInput);
      await assertCallerAuthority(input.listenerAgentId, input.providerBinding, context, options);
      return ledger.reconcile(input.deliveryId, input.inputSha256, input.listenerAgentId);
    },
  };

  return {
    [HOSTED_FLOW_EXTENSION_CAPABILITY]: execute,
    [HOSTED_FLOW_EXTENSION_RECONCILE_CAPABILITY]: reconcile,
  };
}

export const hostedFlowExtensionInputSha256 = (input: HostedFlowExtensionInput): string =>
  sha256(hostedInputSchema.parse(input));
