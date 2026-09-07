import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';

import { defaultApiUrl } from '@agent-relay/cloud';
import type { CloudDependencies } from './cloud.js';

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const APP_WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELAY_WORKSPACE_ID_PATTERN = /^rw_[a-z0-9]{8}$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RECONCILIATION_CONTRACT_HEADER = 'x-agent-relay-ephemeral-reconciliation';
const RECONCILIATION_CONTRACT_VERSION = 'v1';

type WorkspaceCommandDependencies = Pick<
  CloudDependencies,
  'log' | 'error' | 'exit' | 'ensureCloudSession' | 'authorizedApiFetch'
>;

type EphemeralCredentialResponse = {
  version: 1;
  workspaceId: string;
  relayWorkspaceId: string;
  expiresAt: string;
  cloud: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
  };
  relay: {
    baseUrl: string;
    workspaceKey: string;
  };
};

type EphemeralWorkspaceCreateResponse = {
  workspaceId: string;
  relayWorkspaceId: string;
  expiresAt: string;
  state: 'active';
  credential: EphemeralCredentialResponse;
  requestedRelayfileCloudDeploymentId?: string;
  observedRelayfileCloudDeploymentId?: string;
  relayfileCloudAttestationSha256?: string;
};

type EphemeralWorkspaceReconciliationResponse = {
  workspaceId: string;
  relayWorkspaceId: string;
  state: 'provisioning' | 'active' | 'failed' | 'deleting' | 'deleted';
  credentialRevealed: boolean;
  replay: true;
  requestedRelayfileCloudDeploymentId: string;
  observedRelayfileCloudDeploymentId: string;
};

type EphemeralWorkspaceDeleteResponse = {
  workspaceId: string;
  relayWorkspaceId: string;
  expiresAt: string;
  state: 'deleted';
  deleted: true;
  idempotent: boolean;
  operationId: string;
  verifiedAt: string;
  proof: Record<string, unknown>;
};

type EphemeralWorkspaceDeleteResult = EphemeralWorkspaceDeleteResponse & {
  absence: {
    workspaceId: string;
    status: 404;
    verifiedAt: string;
  };
};

type ReservedCredentialFile = {
  absolutePath: string;
  commit(value: unknown): void;
  discard(): void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isCredentialHttpsUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseTtl(value: string): number {
  const match = /^(\d+)([smh]?)$/i.exec(value.trim());
  if (!match) {
    throw new InvalidArgumentError('TTL must be an integer number of seconds or use s, m, or h.');
  }
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1;
  const ttlSeconds = amount * multiplier;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    throw new InvalidArgumentError('TTL must be between 60 seconds and 24 hours.');
  }
  return ttlSeconds;
}

function parseDeploymentId(value: string): string {
  const deploymentId = value.trim();
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    throw new InvalidArgumentError('Relayfile Cloud deployment ID is invalid.');
  }
  return deploymentId;
}

function parseIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/u.test(key)) {
    throw new InvalidArgumentError('Idempotency key must be 8-256 URL-safe characters.');
  }
  return key;
}

function durableCreateIdempotencyKey(absoluteCredentialPath: string): string {
  return `relay-ephemeral:${createHash('sha256').update(absoluteCredentialPath).digest('hex')}`;
}

function reserveCredentialFile(file: string): ReservedCredentialFile {
  const absolutePath = path.resolve(file);
  let descriptor: number | null = fs.openSync(absolutePath, 'wx', 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } finally {
      descriptor = null;
      try {
        fs.unlinkSync(absolutePath);
      } catch {
        // Preserve the permission failure. Nothing has been written yet.
      }
    }
    throw error;
  }

  const close = () => {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
      descriptor = null;
    }
  };
  const discard = () => {
    close();
    try {
      fs.unlinkSync(absolutePath);
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  };

  return {
    absolutePath,
    commit(value) {
      if (descriptor === null) {
        throw new Error('Credential file reservation is closed.');
      }
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        close();
        fs.chmodSync(absolutePath, 0o600);
      } catch (error) {
        try {
          discard();
        } catch {
          // Preserve the original write failure. The file was always 0600 and
          // may contain only a partial credential if unlink also failed.
        }
        throw error;
      }
    },
    discard,
  };
}

function parseCreateResponse(
  value: unknown,
  expectedDeploymentId?: string
): EphemeralWorkspaceCreateResponse | null {
  if (
    !isObject(value) ||
    !APP_WORKSPACE_ID_PATTERN.test(String(value.workspaceId ?? '')) ||
    !RELAY_WORKSPACE_ID_PATTERN.test(String(value.relayWorkspaceId ?? '')) ||
    value.state !== 'active' ||
    !isIsoDate(value.expiresAt) ||
    !isObject(value.credential)
  ) {
    return null;
  }
  const credential = value.credential;
  if (
    credential.version !== 1 ||
    credential.workspaceId !== value.workspaceId ||
    credential.relayWorkspaceId !== value.relayWorkspaceId ||
    credential.expiresAt !== value.expiresAt ||
    !isObject(credential.cloud) ||
    !isObject(credential.relay) ||
    !isNonEmptyString(credential.cloud.accessToken) ||
    !isNonEmptyString(credential.cloud.refreshToken) ||
    !isIsoDate(credential.cloud.accessTokenExpiresAt) ||
    !isIsoDate(credential.cloud.refreshTokenExpiresAt) ||
    !isCredentialHttpsUrl(credential.relay.baseUrl) ||
    !isNonEmptyString(credential.relay.workspaceKey)
  ) {
    return null;
  }
  const requested = value.requestedRelayfileCloudDeploymentId;
  const observed = value.observedRelayfileCloudDeploymentId;
  const attestationSha256 = value.relayfileCloudAttestationSha256;
  const hasBinding = requested !== undefined || observed !== undefined || attestationSha256 !== undefined;
  if (
    (hasBinding &&
      (!isNonEmptyString(requested) ||
        !isNonEmptyString(observed) ||
        requested !== observed ||
        !SHA256_PATTERN.test(String(attestationSha256 ?? '')))) ||
    (expectedDeploymentId !== undefined &&
      (requested !== expectedDeploymentId || observed !== expectedDeploymentId))
  ) {
    return null;
  }
  return value as EphemeralWorkspaceCreateResponse;
}

function parseReconciliationResponse(
  value: unknown,
  expectedDeploymentId?: string
): EphemeralWorkspaceReconciliationResponse | null {
  if (
    !isObject(value) ||
    !APP_WORKSPACE_ID_PATTERN.test(String(value.workspaceId ?? '')) ||
    !RELAY_WORKSPACE_ID_PATTERN.test(String(value.relayWorkspaceId ?? '')) ||
    !['provisioning', 'active', 'failed', 'deleting', 'deleted'].includes(String(value.state)) ||
    typeof value.credentialRevealed !== 'boolean' ||
    value.replay !== true ||
    !isNonEmptyString(value.requestedRelayfileCloudDeploymentId) ||
    !isNonEmptyString(value.observedRelayfileCloudDeploymentId) ||
    value.requestedRelayfileCloudDeploymentId !== value.observedRelayfileCloudDeploymentId ||
    (expectedDeploymentId !== undefined && value.requestedRelayfileCloudDeploymentId !== expectedDeploymentId)
  ) {
    return null;
  }
  return value as EphemeralWorkspaceReconciliationResponse;
}

function parseDeleteResponse(
  value: unknown,
  expectedWorkspaceId: string
): EphemeralWorkspaceDeleteResponse | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      'workspaceId',
      'relayWorkspaceId',
      'expiresAt',
      'state',
      'deleted',
      'idempotent',
      'operationId',
      'verifiedAt',
      'proof',
    ]) ||
    value.workspaceId !== expectedWorkspaceId ||
    !APP_WORKSPACE_ID_PATTERN.test(expectedWorkspaceId) ||
    !RELAY_WORKSPACE_ID_PATTERN.test(String(value.relayWorkspaceId ?? '')) ||
    value.deleted !== true ||
    value.state !== 'deleted' ||
    typeof value.idempotent !== 'boolean' ||
    !isIsoDate(value.expiresAt) ||
    !DEPLOYMENT_ID_PATTERN.test(String(value.operationId ?? '')) ||
    !isIsoDate(value.verifiedAt) ||
    !isObject(value.proof)
  ) {
    return null;
  }
  const relayWorkspaceId = String(value.relayWorkspaceId);
  const proof = value.proof;
  if (!hasExactKeys(proof, ['daytona', 'cloud', 'credentials', 'relaycast', 'relayfile', 'registry'])) {
    return null;
  }
  const daytona = proof.daytona;
  const cloud = proof.cloud;
  const credentials = proof.credentials;
  const relaycast = proof.relaycast;
  const relayfile = proof.relayfile;
  const registry = proof.registry;
  const exactIdentity = (section: Record<string, unknown>, keys: string[]) =>
    hasExactKeys(section, keys) &&
    section.workspaceId === expectedWorkspaceId &&
    section.relayWorkspaceId === relayWorkspaceId;
  if (
    !isObject(daytona) ||
    !exactIdentity(daytona, ['workspaceId', 'relayWorkspaceId', 'remaining']) ||
    daytona.remaining !== 0 ||
    !isObject(cloud) ||
    !exactIdentity(cloud, [
      'workspaceId',
      'relayWorkspaceId',
      'appWorkspaceRowsRemaining',
      'workflowLaunchesInProgress',
    ]) ||
    cloud.appWorkspaceRowsRemaining !== 0 ||
    cloud.workflowLaunchesInProgress !== 0 ||
    !isObject(credentials) ||
    !exactIdentity(credentials, ['workspaceId', 'relayWorkspaceId', 'activeSessionsRemaining']) ||
    credentials.activeSessionsRemaining !== 0 ||
    !isObject(relaycast) ||
    !exactIdentity(relaycast, [
      'workspaceId',
      'relayWorkspaceId',
      'deleted',
      'agentsAndNodesDeletedByWorkspaceCascade',
    ]) ||
    relaycast.deleted !== true ||
    relaycast.agentsAndNodesDeletedByWorkspaceCascade !== true ||
    !isObject(relayfile) ||
    !exactIdentity(relayfile, ['workspaceId', 'relayWorkspaceId', 'deleted']) ||
    relayfile.deleted !== true ||
    !isObject(registry) ||
    !exactIdentity(registry, ['workspaceId', 'relayWorkspaceId', 'deleted']) ||
    registry.deleted !== true
  ) {
    return null;
  }
  return value as EphemeralWorkspaceDeleteResponse;
}

type AuthorizedApiAuth = Parameters<WorkspaceCommandDependencies['authorizedApiFetch']>[0];

async function deleteEphemeralWorkspaceAndVerify(
  deps: WorkspaceCommandDependencies,
  auth: AuthorizedApiAuth,
  workspaceId: string
): Promise<EphemeralWorkspaceDeleteResult> {
  const { response, auth: deleteAuth } = await deps.authorizedApiFetch(
    auth,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: 'DELETE',
      body: JSON.stringify({ confirm: workspaceId, verifyCascade: true }),
    },
    { interactive: false }
  );
  if (!response.ok) {
    throw apiFailure('delete', response.status);
  }
  const deleted = parseDeleteResponse(await response.json().catch(() => null), workspaceId);
  if (!deleted) {
    throw new Error('Cloud did not return complete cascade reconciliation proof.');
  }
  const { response: absenceResponse } = await deps.authorizedApiFetch(
    deleteAuth,
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    { method: 'GET' },
    { interactive: false }
  );
  if (absenceResponse.status !== 404) {
    throw new Error('Cloud did not prove the deleted app workspace is absent.');
  }
  return {
    ...deleted,
    absence: { workspaceId, status: 404, verifiedAt: new Date().toISOString() },
  };
}

async function reconcileAmbiguousCreate(
  deps: WorkspaceCommandDependencies,
  auth: AuthorizedApiAuth,
  idempotencyKey: string,
  expectedDeploymentId?: string
): Promise<{
  workspace: EphemeralWorkspaceReconciliationResponse | null;
  auth: AuthorizedApiAuth;
}> {
  const { response, auth: refreshedAuth } = await deps.authorizedApiFetch(
    auth,
    `/api/v1/workspaces?ephemeral=true&idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
    { method: 'GET' },
    { interactive: false }
  );
  if (response.headers.get(RECONCILIATION_CONTRACT_HEADER) !== RECONCILIATION_CONTRACT_VERSION) {
    throw new Error('Cloud does not advertise the ephemeral workspace reconciliation v1 contract.');
  }
  if (response.status === 404) {
    const missing = await response.json().catch(() => null);
    if (!isObject(missing) || missing.code !== 'workspace_not_found') {
      throw new Error('Cloud returned an invalid workspace reconciliation absence response.');
    }
    return { workspace: null, auth: refreshedAuth };
  }
  if (!response.ok) {
    throw new Error(`Cloud could not reconcile the workspace create request (HTTP ${response.status}).`);
  }
  const reconciled = parseReconciliationResponse(
    await response.json().catch(() => null),
    expectedDeploymentId
  );
  if (!reconciled) {
    throw new Error('Cloud returned an invalid workspace reconciliation response.');
  }
  return { workspace: reconciled, auth: refreshedAuth };
}

function apiFailure(operation: 'create' | 'delete', status: number): Error {
  if (status === 401) {
    return new Error('Cloud login required. Run `agent-relay cloud login` and retry.');
  }
  if (status === 403) {
    return new Error(`Cloud denied permission to ${operation} an ephemeral workspace.`);
  }
  if (status === 404) {
    return new Error('Ephemeral workspace was not found.');
  }
  if (status === 409) {
    return operation === 'delete'
      ? new Error('Ephemeral workspace deletion is already in progress; retry shortly.')
      : new Error('Ephemeral workspace creation conflicts with an existing idempotency request.');
  }
  return new Error(`Cloud failed to ${operation} the ephemeral workspace (HTTP ${status}).`);
}

export function registerCloudWorkspaceCommands(
  cloudCommand: Command,
  deps: WorkspaceCommandDependencies
): void {
  const workspaceCommand = cloudCommand
    .command('workspace')
    .description('Create and delete automation-owned Cloud workspaces');

  workspaceCommand
    .command('create')
    .description('Create a TTL-bounded ephemeral workspace and write its reveal-once credential')
    .requiredOption('--ephemeral', 'Required acknowledgement that this workspace is disposable')
    .requiredOption('--name <name>', 'Workspace audit name')
    .requiredOption('--ttl <duration>', 'TTL: 60-86400 seconds, or a value such as 30m or 24h', parseTtl)
    .requiredOption('--credential-file <path>', 'New file for the reveal-once credential (created 0600)')
    .option('--json', 'Print non-secret result metadata as JSON', false)
    .requiredOption(
      '--relayfile-cloud-deployment <id>',
      'Require an exact prequalified Relayfile Cloud deployment',
      parseDeploymentId
    )
    .option(
      '--idempotency-key <key>',
      'Stable retry key; defaults to a hash of the absolute credential-file path',
      parseIdempotencyKey
    )
    .action(
      async (options: {
        ephemeral: boolean;
        name: string;
        ttl: number;
        credentialFile: string;
        json?: boolean;
        relayfileCloudDeployment: string;
        idempotencyKey?: string;
      }) => {
        let reserved: ReservedCredentialFile | null = null;
        let createAuth: AuthorizedApiAuth | null = null;
        let createRequestSent = false;
        let credentialCommitted = false;
        let createdWorkspaceId: string | null = null;
        let idempotencyKey: string | null = null;
        try {
          reserved = reserveCredentialFile(options.credentialFile);
          idempotencyKey = options.idempotencyKey ?? durableCreateIdempotencyKey(reserved.absolutePath);
          const session = await deps.ensureCloudSession({
            apiUrl: defaultApiUrl(),
            interactive: false,
          });
          createAuth = session.auth;
          // Probe the candidate-aware reconciliation contract before the
          // first mutation. Older Cloud versions ignore unknown POST fields
          // and could otherwise create an unbound workspace.
          const preflight = await reconcileAmbiguousCreate(
            deps,
            createAuth,
            idempotencyKey,
            options.relayfileCloudDeployment
          );
          createAuth = preflight.auth;
          if (preflight.workspace) {
            throw new Error(
              'An ephemeral workspace already exists for this idempotency key; refusing to delete a workspace this process did not create.'
            );
          }
          createRequestSent = true;
          const { response, auth: postAuth } = await deps.authorizedApiFetch(
            createAuth,
            '/api/v1/workspaces',
            {
              method: 'POST',
              headers: { 'idempotency-key': idempotencyKey },
              body: JSON.stringify({
                ephemeral: true,
                name: options.name,
                ttlSeconds: options.ttl,
                idempotencyKey,
                relayfileCloudDeploymentId: options.relayfileCloudDeployment,
              }),
            },
            { interactive: false }
          );
          createAuth = postAuth;
          if (!response.ok) {
            throw apiFailure('create', response.status);
          }
          const created = parseCreateResponse(
            await response.json().catch(() => null),
            options.relayfileCloudDeployment
          );
          if (!created) {
            throw new Error('Cloud returned an invalid ephemeral workspace response.');
          }
          createdWorkspaceId = created.workspaceId;

          reserved.commit({
            ...created.credential,
            cloud: {
              ...created.credential.cloud,
              apiUrl: createAuth.apiUrl,
            },
          });
          credentialCommitted = true;
          const result = {
            workspaceId: created.workspaceId,
            relayWorkspaceId: created.relayWorkspaceId,
            expiresAt: created.expiresAt,
            state: created.state,
            credentialFile: reserved.absolutePath,
            requestedRelayfileCloudDeploymentId: created.requestedRelayfileCloudDeploymentId,
            observedRelayfileCloudDeploymentId: created.observedRelayfileCloudDeploymentId,
            relayfileCloudAttestationSha256: created.relayfileCloudAttestationSha256,
          };
          // The reveal-once credential is now durable. A presentation/logging
          // failure must not erase the only copy the caller can recover.
          reserved = null;
          if (options.json) {
            deps.log(JSON.stringify(result, null, 2));
          } else {
            deps.log(`Ephemeral workspace: ${result.workspaceId}`);
            deps.log(`Relay workspace: ${result.relayWorkspaceId}`);
            deps.log(`Expires: ${result.expiresAt}`);
            deps.log(`Credential file: ${result.credentialFile}`);
          }
        } catch (error) {
          let reconciliationDetail = '';
          if (!credentialCommitted && createRequestSent && createAuth && idempotencyKey) {
            try {
              if (createdWorkspaceId) {
                await deleteEphemeralWorkspaceAndVerify(deps, createAuth, createdWorkspaceId);
              } else {
                const reconciliation = await reconcileAmbiguousCreate(
                  deps,
                  createAuth,
                  idempotencyKey,
                  options.relayfileCloudDeployment
                );
                createAuth = reconciliation.auth;
                if (reconciliation.workspace) {
                  reconciliationDetail =
                    ' Cloud retained a workspace after the ambiguous request; it was not deleted because this process cannot prove ownership. Allow its TTL cleanup before reusing the idempotency key.';
                }
              }
            } catch (reconciliationError) {
              const detail =
                reconciliationError instanceof Error
                  ? reconciliationError.message
                  : 'Cloud workspace reconciliation failed.';
              reconciliationDetail = ` ${detail} Retry only after checking the idempotency key's workspace state.`;
            }
          }
          if (reserved) {
            try {
              reserved.discard();
            } catch {
              // The reservation is always 0600. Do not obscure the original
              // error or print a possibly sensitive path from a thrown value.
            }
          }
          const message = error instanceof Error ? error.message : 'Ephemeral workspace creation failed.';
          deps.error(`${message}${reconciliationDetail}`);
          deps.exit(1);
        }
      }
    );

  workspaceCommand
    .command('delete')
    .description('Delete one exact ephemeral app-workspace UUID and verify its cascade')
    .argument('<uuid>', 'Exact ephemeral app-workspace UUID')
    .requiredOption('--confirm <uuid>', 'Must exactly match the UUID argument')
    .requiredOption('--verify-cascade', 'Require server reconciliation proof for every cleanup phase')
    .option('--json', 'Print the non-secret cascade result as JSON', false)
    .action(
      async (workspaceId: string, options: { confirm: string; verifyCascade: boolean; json?: boolean }) => {
        try {
          if (!APP_WORKSPACE_ID_PATTERN.test(workspaceId)) {
            throw new Error('Workspace must be an app-workspace UUID.');
          }
          if (options.confirm !== workspaceId) {
            throw new Error('--confirm must exactly match the workspace UUID.');
          }
          if (options.verifyCascade !== true) {
            throw new Error('--verify-cascade is required.');
          }
          const session = await deps.ensureCloudSession({
            apiUrl: defaultApiUrl(),
            interactive: false,
          });
          const result = await deleteEphemeralWorkspaceAndVerify(deps, session.auth, workspaceId);
          if (options.json) {
            deps.log(JSON.stringify(result, null, 2));
          } else {
            deps.log(
              `${result.idempotent ? 'Already deleted' : 'Deleted'} ephemeral workspace ${workspaceId}.`
            );
            deps.log('Cascade reconciliation: complete');
          }
        } catch (error) {
          deps.error(error instanceof Error ? error.message : 'Ephemeral workspace deletion failed.');
          deps.exit(1);
        }
      }
    );
}
