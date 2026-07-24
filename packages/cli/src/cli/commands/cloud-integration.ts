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
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

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

function providerId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROVIDER_ID.test(normalized)) throw new Error('Invalid integration provider ID.');
  return normalized;
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
  const auth =
    priorAuth ??
    (
      await deps.ensureCloudSession({
        apiUrl: requested,
        interactive: false,
      })
    ).auth;
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
      string(provider.id, 'integration provider');
      return sanitize(provider) as Record<string, unknown>;
    }),
    version: string(response.version, 'integration catalog'),
  };
}

function renderProviders(catalog: ReturnType<typeof normalizeCatalog>, deps: Dependencies): void {
  for (const provider of catalog.providers) {
    const backends = Array.isArray(provider.backends)
      ? provider.backends.map(String)
      : [provider.backend].filter(Boolean).map(String);
    deps.log(
      [
        terminal(String(provider.id ?? 'unknown')),
        backends.length > 0 ? backends.join(',') : 'backend-unspecified',
      ].join('  ')
    );
  }
}

function renderConnections(payload: unknown, deps: Dependencies): void {
  if (!Array.isArray(payload)) {
    throw new Error('Cloud returned an invalid integration connection list.');
  }
  if (payload.length === 0) {
    deps.log('No connected workspace integrations.');
    return;
  }
  for (const entry of payload) {
    const connection = object(entry, 'integration connection');
    const id = [connection.id, connection.provider, connection.providerId].find(
      (value) => typeof value === 'string' && value.trim()
    );
    if (typeof id !== 'string') {
      throw new Error('Cloud returned an invalid integration connection list.');
    }
    const status =
      typeof connection.status === 'string' && connection.status.trim()
        ? terminal(connection.status)
        : undefined;
    deps.log([terminal(id), status].filter(Boolean).join('  '));
  }
}

export function registerCloudIntegrationCommands(cloudCommand: Command, deps: Dependencies): void {
  const integration = cloudCommand
    .command('integration')
    .description('Manage Agent Relay Cloud integration connections');

  integration
    .command('catalog')
    .description('Discover static and dynamic Cloud integrations')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--static', 'Exclude dynamic Nango and Composio catalog entries')
    .option('--search <query>', 'Filter providers by ID or display name')
    .option('--backend <backend>', 'Filter providers by nango or composio', backend)
    .option('--json', 'Output the integration catalog as JSON')
    .action(
      async (options: {
        apiUrl?: string;
        static?: boolean;
        search?: string;
        backend?: 'nango' | 'composio';
        json?: boolean;
      }) => {
        await action(deps, async () => {
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
        else renderConnections(payload, deps);
      });
    });

  integration
    .command('connect')
    .description('Create a Cloud connection session for a provider')
    .argument('<provider>', 'Provider ID from the catalog')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--backend <backend>', 'Connection backend: nango or composio', backend)
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output safe connection-session details as JSON')
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
}
