import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';

import { defaultApiUrl } from '@agent-relay/cloud';
import { stripAnsiFast } from '@agent-relay/utils';

import type { CloudDependencies } from './cloud.js';

type Dependencies = Pick<
  CloudDependencies,
  'log' | 'error' | 'exit' | 'ensureCloudSession' | 'authorizedApiFetch'
>;
type CloudAuth = Awaited<ReturnType<CloudDependencies['ensureCloudSession']>>['auth'];

const WORKSPACE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELAY_WORKSPACE = /^rw_[a-z0-9]{8}$/;
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MAX_SECRET_BYTES = 512 * 1024;
const DEFAULT_CREDENTIAL_TTL = 3_600;
const DEFAULT_DELEGATION_TTL = 86_400;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`Cloud returned an invalid ${label} response.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cloud returned an invalid ${label} response.`);
  }
  return value.trim();
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Cloud returned an invalid ${label} response.`);
  }
  return value.map((entry) => string(entry, label));
}

function connectionProviderIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Cloud returned an invalid integration connection response.');
  }
  return value.map((entry) => {
    if (typeof entry === 'string') return string(entry, 'integration connection');
    return string(object(entry, 'integration connection provider').id, 'integration connection');
  });
}

function workspaceId(value: string): string {
  const normalized = value.trim();
  if (!WORKSPACE_UUID.test(normalized) && !RELAY_WORKSPACE.test(normalized)) {
    throw new Error(
      'Unsupported Cloud workspace identifier. Use a Cloud workspace UUID or unified rw_ workspace ID.'
    );
  }
  return normalized;
}

function resourceId(value: string, label: string): string {
  const normalized = value.trim();
  if (!RESOURCE_ID.test(normalized)) throw new Error(`Invalid ${label}.`);
  return normalized;
}

function providerId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROVIDER_ID.test(normalized)) throw new Error('Invalid integration provider ID.');
  return normalized;
}

function deviceId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 255 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f]/.test(normalized)
  ) {
    throw new InvalidArgumentError(
      'Expected a non-empty device ID of at most 255 characters without control characters.'
    );
  }
  return normalized;
}

function canonicalPath(value: string): string {
  const normalized = value.trim();
  if (
    !normalized.startsWith('/') ||
    normalized.length > 2_048 ||
    normalized.includes('\0') ||
    normalized.includes('\\') ||
    normalized.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('Integration paths must be canonical absolute Relayfile paths.');
  }
  return normalized;
}

function positiveInt(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError('Expected a positive whole number.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError('Expected a safe whole number.');
  return parsed;
}

function pathList(value: string, previous: string[] = []): string[] {
  return [...previous, canonicalPath(value)];
}

function access(value: string): 'read' | 'write' {
  if (value === 'read' || value === 'write') return value;
  throw new InvalidArgumentError('Expected access to be one of: read, write');
}

function backend(value: string): 'nango' | 'composio' {
  if (value === 'nango' || value === 'composio') return value;
  throw new InvalidArgumentError('Expected backend to be one of: nango, composio');
}

function canonicalApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid Cloud API URL.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Cloud API URL.');
  }
  return url.toString().replace(/\/+$/, '');
}

function cloudError(response: Response): Error {
  if (response.status === 401) {
    return new Error('Cloud login required. Run `agent-relay cloud login` and retry.');
  }
  if (response.status === 403) {
    return new Error('You do not have permission to perform that integration operation.');
  }
  if (response.status === 404) {
    return new Error('The integration resource was not found or is no longer available.');
  }
  if (response.status === 409) {
    return new Error('The integration operation conflicts with its current lifecycle state.');
  }
  if (response.status === 429) {
    return new Error('Cloud integration rate limit exceeded. Wait and retry.');
  }
  return new Error(`Cloud integration request failed (${response.status}).`);
}

async function requestWithAuth(
  deps: Dependencies,
  path: string,
  init: RequestInit,
  apiUrl?: string,
  priorAuth?: CloudAuth
): Promise<{ payload: unknown; auth: CloudAuth }> {
  const requested = apiUrl ?? defaultApiUrl();
  const auth = priorAuth ?? (await deps.ensureCloudSession({ apiUrl: requested, interactive: false })).auth;
  if (apiUrl && canonicalApiUrl(auth.apiUrl) !== canonicalApiUrl(requested)) {
    throw new Error(
      `Cloud login is bound to ${canonicalApiUrl(
        auth.apiUrl
      )}. Run \`agent-relay cloud login --api-url ${canonicalApiUrl(
        requested
      )} --force\` before using this host.`
    );
  }
  const result = await deps.authorizedApiFetch(auth, path, init, {
    interactive: false,
  });
  const payload = (await result.response.json().catch(() => null)) as unknown;
  if (!result.response.ok) throw cloudError(result.response);
  return { payload, auth: result.auth };
}

async function request(
  deps: Dependencies,
  path: string,
  init: RequestInit,
  apiUrl?: string
): Promise<unknown> {
  return (await requestWithAuth(deps, path, init, apiUrl)).payload;
}

async function action(deps: Dependencies, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    deps.exit(1);
  }
}

function terminal(value: string): string {
  return (
    stripAnsiFast(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�')
      .trim()
  );
}

function secretField(key: string): boolean {
  return /(?:token|secret|password|authorization|credential|api[_-]?key)/i.test(key);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!isObject(value)) return typeof value === 'string' ? terminal(value) : value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !secretField(key))
      .map(([key, nested]) => [key, sanitize(nested)])
  );
}

function json(deps: Dependencies, payload: unknown): void {
  deps.log(JSON.stringify(payload, null, 2));
}

function normalizeCatalog(payload: unknown): {
  providers: Array<Record<string, unknown>>;
  version: string;
} {
  const response = object(payload, 'integration catalog');
  if (!Array.isArray(response.providers)) {
    throw new Error('Cloud returned an invalid integration catalog response.');
  }
  return {
    providers: response.providers.map((entry) => {
      const provider = object(entry, 'integration provider');
      const capabilities = object(provider.capabilities, 'integration capabilities');
      if (
        typeof capabilities.connect !== 'boolean' ||
        typeof capabilities.read !== 'boolean' ||
        typeof capabilities.writeback !== 'boolean'
      ) {
        throw new Error('Cloud returned invalid integration capabilities.');
      }
      return sanitize(provider) as Record<string, unknown>;
    }),
    version: string(response.version, 'integration catalog'),
  };
}

function normalizeGrant(value: unknown): Record<string, unknown> {
  const grant = object(value, 'integration grant');
  const normalized = {
    id: string(grant.id, 'integration grant'),
    workspaceId: string(grant.workspaceId, 'integration grant'),
    memberId: string(grant.memberId, 'integration grant'),
    userId: string(grant.userId, 'integration grant'),
    provider: string(grant.provider, 'integration grant'),
    allowedPaths: stringArray(grant.allowedPaths, 'integration grant'),
    canRead: grant.canRead,
    canWrite: grant.canWrite,
    createdAt: string(grant.createdAt, 'integration grant'),
    updatedAt: string(grant.updatedAt, 'integration grant'),
  };
  if (typeof normalized.canRead !== 'boolean' || typeof normalized.canWrite !== 'boolean') {
    throw new Error('Cloud returned an invalid integration grant response.');
  }
  return normalized;
}

function normalizeGrants(payload: unknown): { grants: Array<Record<string, unknown>> } {
  const response = object(payload, 'integration grants');
  if (!Array.isArray(response.grants)) {
    throw new Error('Cloud returned an invalid integration grants response.');
  }
  return { grants: response.grants.map(normalizeGrant) };
}

function normalizeGrantCreate(payload: unknown): { grant: Record<string, unknown> } {
  return { grant: normalizeGrant(object(payload, 'integration grant').grant) };
}

type DelegatedCredential = {
  leaseId: string;
  relayfileUrl: string;
  relayauthUrl: string;
  refreshUrl: string;
  relayfileWorkspaceId: string;
  relayfileToken: string | null;
  relayfileTokenExpiresAt: string | null;
  relayfileRefreshToken: string | null;
  relayfileRefreshTokenExpiresAt: string | null;
  relayfileScopes: string[];
  delegationNotAfter: string | null;
  relayfileMountPaths: string[];
};

function serviceUrl(value: unknown, label: string): string {
  const raw = string(value, label);
  const canonical = canonicalApiUrl(raw);
  return canonical;
}

function normalizeCredential(payload: unknown): DelegatedCredential {
  const candidate = object(
    isObject(payload) && payload.credential !== undefined ? payload.credential : payload,
    'delegated credential'
  );
  return {
    leaseId: resourceId(string(candidate.leaseId, 'delegated credential'), 'credential lease ID'),
    relayfileUrl: serviceUrl(candidate.relayfileUrl, 'delegated credential'),
    relayauthUrl: serviceUrl(candidate.relayauthUrl, 'delegated credential'),
    refreshUrl: serviceUrl(candidate.refreshUrl, 'delegated credential'),
    relayfileWorkspaceId: string(candidate.relayfileWorkspaceId, 'delegated credential'),
    relayfileToken: nullableString(candidate.relayfileToken, 'delegated credential'),
    relayfileTokenExpiresAt: nullableString(candidate.relayfileTokenExpiresAt, 'delegated credential'),
    relayfileRefreshToken: nullableString(candidate.relayfileRefreshToken, 'delegated credential'),
    relayfileRefreshTokenExpiresAt: nullableString(
      candidate.relayfileRefreshTokenExpiresAt,
      'delegated credential'
    ),
    relayfileScopes: stringArray(candidate.relayfileScopes, 'delegated credential'),
    delegationNotAfter: nullableString(candidate.delegationNotAfter, 'delegated credential'),
    relayfileMountPaths: stringArray(candidate.relayfileMountPaths, 'delegated credential'),
  };
}

async function writeCredentialFile(path: string, credential: DelegatedCredential): Promise<void> {
  const payload = `${JSON.stringify(credential, null, 2)}\n`;
  if (Buffer.byteLength(payload) > MAX_SECRET_BYTES) {
    throw new Error('Delegated credential response exceeded the safe output limit.');
  }
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600
  );
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function renderProviders(catalog: ReturnType<typeof normalizeCatalog>, deps: Dependencies): void {
  for (const provider of catalog.providers) {
    const capabilities = provider.capabilities as Record<string, boolean>;
    deps.log(
      [
        terminal(String(provider.id ?? 'unknown')),
        capabilities.read ? 'read' : 'no-read',
        capabilities.writeback ? 'write' : 'no-write',
        capabilities.connect ? 'connect' : 'no-connect',
      ].join('  ')
    );
  }
}

export function registerCloudIntegrationCommands(cloudCommand: Command, deps: Dependencies): void {
  const integration = cloudCommand
    .command('integration')
    .description('Manage Cloud integrations and delegated Relayfile access');

  integration
    .command('catalog')
    .description('Discover integrations and their truthful capabilities')
    .option('--workspace <workspace>', 'Optional Cloud UUID or unified rw_ workspace context')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--static', 'Exclude dynamic Nango and Composio catalog entries')
    .option('--search <query>', 'Filter providers by ID or display name')
    .option('--backend <backend>', 'Filter providers by nango or composio', backend)
    .option('--json', 'Output the integration catalog as JSON')
    .action(
      async (options: {
        workspace?: string;
        apiUrl?: string;
        static?: boolean;
        search?: string;
        backend?: 'nango' | 'composio';
        json?: boolean;
      }) => {
        await action(deps, async () => {
          if (options.workspace) workspaceId(options.workspace);
          const catalog = normalizeCatalog(
            await request(
              deps,
              `/api/v1/integrations/catalog?dynamic=${options.static ? 'false' : 'true'}`,
              { method: 'GET' },
              options.apiUrl
            )
          );
          const query = options.search?.trim().toLowerCase();
          const payload = {
            ...catalog,
            providers: catalog.providers.filter((provider) => {
              const haystack = `${String(provider.id ?? '')} ${String(
                provider.displayName ?? ''
              )}`.toLowerCase();
              const backends = Array.isArray(provider.backends)
                ? provider.backends
                : [provider.backend].filter(Boolean);
              return (
                (!query || haystack.includes(query)) &&
                (!options.backend || backends.includes(options.backend))
              );
            }),
          };
          if (options.json) json(deps, payload);
          else renderProviders(payload, deps);
        });
      }
    );

  integration
    .command('connections')
    .description('List connected workspace integrations')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output connections as JSON')
    .action(async (options: { workspace: string; apiUrl?: string; json?: boolean }) => {
      await action(deps, async () => {
        const id = workspaceId(options.workspace);
        const payload = sanitize(
          await request(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(id)}/integrations`,
            { method: 'GET' },
            options.apiUrl
          )
        );
        if (options.json) json(deps, payload);
        else json(deps, payload);
      });
    });

  integration
    .command('connect')
    .description('Create a Cloud connection session for a provider')
    .argument('<provider>', 'Provider ID from the catalog')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--backend <backend>', 'Connection backend: nango or composio', backend)
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the safe connection-session details as JSON')
    .action(
      async (
        providerInput: string,
        options: {
          workspace: string;
          backend?: 'nango' | 'composio';
          apiUrl?: string;
          json?: boolean;
        }
      ) => {
        await action(deps, async () => {
          const id = workspaceId(options.workspace);
          const provider = providerId(providerInput);
          const response = object(
            await request(
              deps,
              `/api/v1/workspaces/${encodeURIComponent(id)}/integrations/connect-session`,
              {
                method: 'POST',
                body: JSON.stringify({
                  allowedIntegrations: [provider],
                  ...(options.backend ? { requestedBackend: options.backend } : {}),
                }),
              },
              options.apiUrl
            ),
            'integration connection'
          );
          const payload = {
            connectLink: string(response.connectLink, 'integration connection'),
            workspaceId: string(response.workspaceId, 'integration connection'),
            relayWorkspaceId: string(response.relayWorkspaceId, 'integration connection'),
            backend: string(response.backend, 'integration connection'),
            providers: connectionProviderIds(response.providers),
            ...(typeof response.expiresAt === 'string' ? { expiresAt: response.expiresAt } : {}),
          };
          if (options.json) json(deps, payload);
          else deps.log(payload.connectLink);
        });
      }
    );

  integration
    .command('disconnect')
    .description('Disconnect a provider from the workspace')
    .argument('<provider>', 'Provider ID')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the disconnection result as JSON')
    .action(
      async (providerInput: string, options: { workspace: string; apiUrl?: string; json?: boolean }) => {
        await action(deps, async () => {
          const id = workspaceId(options.workspace);
          const provider = providerId(providerInput);
          await request(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(id)}/integrations/${encodeURIComponent(
              provider
            )}/status`,
            { method: 'DELETE' },
            options.apiUrl
          );
          if (options.json) json(deps, { success: true });
          else deps.log(`Disconnected ${terminal(provider)}.`);
        });
      }
    );

  integration
    .command('grants')
    .description('List room integration grants')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output grants as JSON')
    .action(async (options: { workspace: string; apiUrl?: string; json?: boolean }) => {
      await action(deps, async () => {
        const id = workspaceId(options.workspace);
        const payload = normalizeGrants(
          await request(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(id)}/room/integration-grants`,
            { method: 'GET' },
            options.apiUrl
          )
        );
        if (options.json) json(deps, payload);
        else json(deps, payload);
      });
    });

  integration
    .command('grant')
    .description('Grant a room member bounded integration access')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .requiredOption('--member <member>', 'Room membership ID')
    .requiredOption('--provider <provider>', 'Provider ID from the catalog')
    .requiredOption('--path <path>', 'Canonical allowed path; repeat for more paths', pathList, [])
    .requiredOption('--access <access>', 'Grant read or write access', access)
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the grant as JSON')
    .action(
      async (options: {
        workspace: string;
        member: string;
        provider: string;
        path: string[];
        access: 'read' | 'write';
        apiUrl?: string;
        json?: boolean;
      }) => {
        await action(deps, async () => {
          const id = workspaceId(options.workspace);
          const payload = normalizeGrantCreate(
            await request(
              deps,
              `/api/v1/workspaces/${encodeURIComponent(id)}/room/integration-grants`,
              {
                method: 'POST',
                body: JSON.stringify({
                  memberId: resourceId(options.member, 'membership ID'),
                  provider: providerId(options.provider),
                  allowedPaths: options.path,
                  canRead: true,
                  canWrite: options.access === 'write',
                }),
              },
              options.apiUrl
            )
          );
          if (options.json) json(deps, payload);
          else deps.log(`Integration grant ${terminal(String(payload.grant.id))} is active.`);
        });
      }
    );

  integration
    .command('revoke-grant')
    .description('Revoke a room integration grant and its delegated credentials')
    .argument('<grant-id>', 'Integration grant ID')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the revocation result as JSON')
    .action(async (grantInput: string, options: { workspace: string; apiUrl?: string; json?: boolean }) => {
      await action(deps, async () => {
        const id = workspaceId(options.workspace);
        const grant = resourceId(grantInput, 'grant ID');
        await request(
          deps,
          `/api/v1/workspaces/${encodeURIComponent(id)}/room/integration-grants/${encodeURIComponent(grant)}`,
          { method: 'DELETE' },
          options.apiUrl
        );
        if (options.json) json(deps, { success: true });
        else deps.log(`Revoked integration grant ${terminal(grant)}.`);
      });
    });

  integration
    .command('credential')
    .description('Mint a grant-bounded delegated Relayfile credential lease')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .requiredOption(
      '--device-id <device-id>',
      'Stable non-secret ID for this Herdr/Relayfile device',
      deviceId
    )
    .requiredOption('--access <access>', 'Request read or write access', access)
    .option('--path <path>', 'Request a granted path; repeat for more paths', pathList, [])
    .option('--ttl <seconds>', 'Access-token lifetime', positiveInt, DEFAULT_CREDENTIAL_TTL)
    .option(
      '--delegation-ttl <seconds>',
      'Maximum refresh/delegation lifetime',
      positiveInt,
      DEFAULT_DELEGATION_TTL
    )
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--output-file <path>', 'Write the credential to a new owner-only 0600 file')
    .option('--json', 'Output the delegated credential, including its secrets, as JSON')
    .action(
      async (options: {
        workspace: string;
        deviceId: string;
        access: 'read' | 'write';
        path: string[];
        ttl: number;
        delegationTtl: number;
        apiUrl?: string;
        outputFile?: string;
        json?: boolean;
      }) => {
        await action(deps, async () => {
          if (Boolean(options.outputFile) === Boolean(options.json)) {
            throw new Error('Use exactly one credential sink: --output-file or --json.');
          }
          if (options.ttl > 3_600 || options.delegationTtl > 86_400) {
            throw new Error('Credential TTL exceeds the Cloud maximum.');
          }
          const id = workspaceId(options.workspace);
          const minted = await requestWithAuth(
            deps,
            `/api/v1/workspaces/${encodeURIComponent(id)}/relayfile/delegated-token`,
            {
              method: 'POST',
              body: JSON.stringify({
                deviceId: options.deviceId,
                scopes: options.access === 'write' ? ['fs:read', 'fs:write'] : ['fs:read'],
                ...(options.path.length > 0 ? { relayfileMountPaths: options.path } : {}),
                ttlSeconds: options.ttl,
                delegationTtlSeconds: options.delegationTtl,
              }),
            },
            options.apiUrl
          );
          const credential = normalizeCredential(minted.payload);
          if (options.json) {
            json(deps, credential);
            return;
          }
          try {
            await writeCredentialFile(options.outputFile ?? '', credential);
          } catch (writeError) {
            try {
              await requestWithAuth(
                deps,
                `/api/v1/workspaces/${encodeURIComponent(
                  id
                )}/relayfile/delegated-token/${encodeURIComponent(credential.leaseId)}`,
                { method: 'DELETE' },
                options.apiUrl,
                minted.auth
              );
            } catch {
              throw new Error(
                `Could not write the delegated credential. Revocation could not be confirmed; revoke lease ${terminal(
                  credential.leaseId
                )} before retrying.`
              );
            }
            throw writeError;
          }
          deps.log(`Wrote delegated Relayfile credential lease ${terminal(credential.leaseId)}.`);
        });
      }
    );

  integration
    .command('revoke-credential')
    .description('Revoke this member’s delegated Relayfile credential lease')
    .argument('<lease-id>', 'Credential lease ID')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output the revocation result as JSON')
    .action(async (leaseInput: string, options: { workspace: string; apiUrl?: string; json?: boolean }) => {
      await action(deps, async () => {
        const id = workspaceId(options.workspace);
        const lease = resourceId(leaseInput, 'credential lease ID');
        await request(
          deps,
          `/api/v1/workspaces/${encodeURIComponent(
            id
          )}/relayfile/delegated-token/${encodeURIComponent(lease)}`,
          { method: 'DELETE' },
          options.apiUrl
        );
        if (options.json) json(deps, { success: true });
        else deps.log(`Revoked delegated Relayfile credential lease ${terminal(lease)}.`);
      });
    });
}
