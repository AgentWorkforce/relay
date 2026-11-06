import { readFile, stat } from 'node:fs/promises';

import { Command } from 'commander';

import { stripAnsiFast } from '@agent-relay/utils';

import type { CloudDependencies } from './cloud.js';

type Dependencies = Pick<CloudDependencies, 'log' | 'error' | 'exit'>;
type Request = (path: string, init: RequestInit, apiUrl?: string) => Promise<unknown>;

type Helpers = {
  request: Request;
  workspaceId: (value: string) => string;
  providerId: (value: string) => string;
};

type AccessibleResource = {
  id: string;
  url: string;
  name?: string;
  path?: string;
};

type ConfigureOptions = {
  workspace: string;
  project: string[];
  manualWebhooks?: boolean;
  managedWebhooks?: boolean;
  webhookSecretFile?: string;
  apiUrl?: string;
  json?: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`Cloud returned an invalid ${label} response.`);
  return value;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return (
    stripAnsiFast(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�')
      .trim()
  );
}

function resources(payload: unknown): AccessibleResource[] {
  const rows = object(payload, 'accessible resources').resources;
  if (!Array.isArray(rows)) throw new Error('Cloud returned an invalid accessible resources response.');
  return rows.map((entry) => {
    const row = object(entry, 'accessible resource');
    const id = text(row.id);
    const url = text(row.url);
    if (!id || !url) throw new Error('Cloud returned an invalid accessible resource.');
    const name = text(row.name);
    const path = text(row.path);
    return { id, url, ...(name ? { name } : {}), ...(path ? { path } : {}) };
  });
}

function json(deps: Dependencies, value: unknown): void {
  deps.log(JSON.stringify(value, null, 2));
}

async function action(deps: Dependencies, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    deps.error(error instanceof Error ? error.message : String(error));
    deps.exit(1);
  }
}

function collect(value: string, prior: string[]): string[] {
  return [...prior, value];
}

async function readWebhookSecret(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('The webhook secret path must name a regular file.');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error(
      'The webhook secret file must not be readable or writable by group or other users (chmod 600).'
    );
  }
  const secret = (await readFile(path, 'utf8')).trim();
  const hasControlCharacter = [...secret].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (secret.length < 32 || secret.length > 512 || hasControlCharacter) {
    throw new Error(
      'The webhook secret file must contain one printable secret between 32 and 512 characters.'
    );
  }
  return secret;
}

function metadata(payload: unknown): Record<string, unknown> {
  return object(object(payload, 'integration metadata').metadata, 'integration metadata');
}

function renderResources(rows: AccessibleResource[], deps: Dependencies): void {
  if (rows.length === 0) {
    deps.log('No accessible integration resources.');
    return;
  }
  for (const row of rows) deps.log([row.id, row.path ?? row.name ?? row.url].join('  '));
}

function statusView(payload: unknown): Record<string, unknown> {
  const status = object(payload, 'integration status');
  const configuration = isObject(status.configuration)
    ? {
        complete: status.configuration.complete === true,
        selectedProjectCount:
          typeof status.configuration.selectedProjectCount === 'number'
            ? status.configuration.selectedProjectCount
            : 0,
        ...(text(status.configuration.reason) ? { reason: text(status.configuration.reason) } : {}),
      }
    : null;
  return {
    provider: text(status.provider) ?? 'unknown',
    ready: status.ready === true,
    state: text(status.state) ?? 'unknown',
    currentConnectionId: text(status.currentConnectionId) ?? null,
    configKey: text(status.configKey) ?? null,
    configuration,
    eventIngressReady: typeof status.eventIngressReady === 'boolean' ? status.eventIngressReady : null,
    webhookHealthy: typeof status.webhookHealthy === 'boolean' ? status.webhookHealthy : null,
  };
}

function configureSelection(options: ConfigureOptions): {
  ids: string[];
  manageWebhooks: boolean;
} {
  const ids = [...new Set(options.project.map((entry) => entry.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error('Select at least one project with --project <id>.');
  if (options.manualWebhooks === options.managedWebhooks) {
    throw new Error('Choose exactly one of --manual-webhooks or --managed-webhooks.');
  }
  if (options.managedWebhooks && options.webhookSecretFile) {
    throw new Error('--webhook-secret-file is only valid with --manual-webhooks.');
  }
  return { ids, manageWebhooks: options.managedWebhooks === true };
}

function selectResources(available: AccessibleResource[], ids: string[]): AccessibleResource[] {
  const byId = new Map(available.map((resource) => [resource.id, resource]));
  return ids.map((id) => {
    const resource = byId.get(id);
    if (!resource) throw new Error(`GitLab project ${id} is not accessible to this connection.`);
    if (!resource.path?.includes('/')) {
      throw new Error(`GitLab project ${id} has no usable path_with_namespace.`);
    }
    return resource;
  });
}

async function resolveManualWebhookSecret(
  options: ConfigureOptions,
  manageWebhooks: boolean,
  existing: Record<string, unknown>
): Promise<string | undefined> {
  if (manageWebhooks) return undefined;
  if (options.webhookSecretFile) return readWebhookSecret(options.webhookSecretFile);
  if (existing.manageWebhooks === false && existing.webhookSecret === '[redacted]') return undefined;
  throw new Error(
    'First-time manual hook setup needs --webhook-secret-file <chmod-600-file>. The secret is never accepted on argv or printed.'
  );
}

function renderConfiguredGitLab(
  deps: Dependencies,
  options: ConfigureOptions,
  result: Record<string, unknown>,
  projectCount: number,
  webhookSecret: string | undefined
): void {
  if (options.json) {
    json(deps, result);
    return;
  }
  deps.log(`Configured gitlab for ${projectCount} project${projectCount === 1 ? '' : 's'}.`);
  if (options.managedWebhooks) return;
  if (typeof result.webhookUrl === 'string') deps.log(`Webhook URL: ${result.webhookUrl}`);
  deps.log(
    webhookSecret
      ? `Webhook secret: use the value in ${options.webhookSecretFile}.`
      : 'Webhook secret: retained from the existing manual-hook configuration.'
  );
  deps.log('A project Maintainer or Owner must install the hook, then deliver a test event.');
}

async function configureGitLab(
  providerInput: string,
  options: ConfigureOptions,
  deps: Dependencies,
  helpers: Helpers
): Promise<void> {
  const workspace = helpers.workspaceId(options.workspace);
  const provider = helpers.providerId(providerInput);
  if (provider !== 'gitlab') {
    throw new Error('Resource configuration currently supports only the gitlab provider.');
  }
  const { ids, manageWebhooks } = configureSelection(options);
  const base = `/api/v1/workspaces/${encodeURIComponent(workspace)}/integrations/gitlab`;
  const available = resources(
    await helpers.request(`${base}/accessible-resources`, { method: 'GET' }, options.apiUrl)
  );
  const selected = selectResources(available, ids);
  const existing = metadata(await helpers.request(`${base}/metadata`, { method: 'GET' }, options.apiUrl));
  const webhookSecret = await resolveManualWebhookSecret(options, manageWebhooks, existing);
  const projects = selected.map((resource) => ({
    id: resource.id,
    path_with_namespace: resource.path,
    name_with_namespace: resource.name ?? resource.path,
    web_url: resource.url,
  }));
  const saved = metadata(
    await helpers.request(
      `${base}/metadata`,
      {
        method: 'PUT',
        body: JSON.stringify({
          metadata: {
            projectIds: projects.map((project) => project.id),
            projects,
            manageWebhooks,
            ...(webhookSecret ? { webhookSecret } : {}),
          },
        }),
      },
      options.apiUrl
    )
  );
  const webhookUrl = text(saved.webhookUrl);
  const result = {
    provider,
    projectIds: projects.map((project) => project.id),
    projects,
    manageWebhooks,
    ...(webhookUrl ? { webhookUrl } : {}),
    manualWebhookSecret: manageWebhooks
      ? 'not_required'
      : webhookSecret
        ? 'loaded_from_file'
        : 'existing_secret_retained',
  };
  renderConfiguredGitLab(deps, options, result, projects.length, webhookSecret);
}

export function registerCloudIntegrationConfigurationCommands(
  integration: Command,
  deps: Dependencies,
  helpers: Helpers
): void {
  integration
    .command('resources')
    .description('List resources accessible through an existing integration connection')
    .argument('<provider>', 'Connected provider ID')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output accessible resources as JSON')
    .action(
      async (providerInput: string, options: { workspace: string; apiUrl?: string; json?: boolean }) => {
        await action(deps, async () => {
          const workspace = helpers.workspaceId(options.workspace);
          const provider = helpers.providerId(providerInput);
          const rows = resources(
            await helpers.request(
              `/api/v1/workspaces/${encodeURIComponent(workspace)}/integrations/${encodeURIComponent(
                provider
              )}/accessible-resources`,
              { method: 'GET' },
              options.apiUrl
            )
          );
          if (options.json) json(deps, { provider, resources: rows });
          else renderResources(rows, deps);
        });
      }
    );

  integration
    .command('configure')
    .description('Configure selected resources on an existing integration connection')
    .argument('<provider>', 'Connected provider ID (currently gitlab)')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--project <id>', 'Exact GitLab project ID to select; repeat for more projects', collect, [])
    .option('--manual-webhooks', 'A project Maintainer or Owner will install the webhook')
    .option('--managed-webhooks', 'Allow Agent Relay to install project webhooks')
    .option('--webhook-secret-file <path>', 'Read a manual-hook secret from a chmod 600 file')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output safe configuration details as JSON')
    .action(async (providerInput: string, options: ConfigureOptions) => {
      await action(deps, () => configureGitLab(providerInput, options, deps, helpers));
    });

  integration
    .command('status')
    .description('Show connection, selection, sync, and event-ingress readiness')
    .argument('<provider>', 'Connected provider ID')
    .requiredOption('--workspace <workspace>', 'Cloud UUID or unified rw_ workspace ID')
    .option('--api-url <url>', 'Cloud API base URL')
    .option('--json', 'Output integration readiness as JSON')
    .action(
      async (providerInput: string, options: { workspace: string; apiUrl?: string; json?: boolean }) => {
        await action(deps, async () => {
          const workspace = helpers.workspaceId(options.workspace);
          const provider = helpers.providerId(providerInput);
          const result = statusView(
            await helpers.request(
              `/api/v1/workspaces/${encodeURIComponent(workspace)}/integrations/${encodeURIComponent(
                provider
              )}/status`,
              { method: 'GET' },
              options.apiUrl
            )
          );
          if (options.json) json(deps, result);
          else {
            deps.log(`${provider}  ${String(result.state)}`);
            const configuration = result.configuration as Record<string, unknown> | null;
            if (configuration) {
              deps.log(
                `projects  ${String(configuration.selectedProjectCount)}  ${String(
                  configuration.reason ?? 'unknown'
                )}`
              );
            }
            deps.log(
              `event ingress  ${
                result.eventIngressReady === true
                  ? 'ready'
                  : result.eventIngressReady === false
                    ? 'not ready'
                    : 'unknown'
              }`
            );
          }
        });
      }
    );
}
