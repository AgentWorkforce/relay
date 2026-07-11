import type { Command } from 'commander';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { getProjectPaths } from '@agent-relay/config';
import type { AgentRelayAgent } from '@agent-relay/sdk';

import {
  cleanupEntryKey,
  fileCleanupJournal,
  type CleanupJournal,
  type PendingCleanupEntry,
  type PendingCleanupOwner,
} from './integration-cleanup-journal.js';

import {
  addSdkOptions,
  printJson,
  runSdk,
  sdkOptionsFromOpts,
  withSdkDefaults,
  type SdkCommandDeps,
} from '../lib/sdk-command.js';
import { connectProjectBrokerClient } from '../lib/project-broker-client.js';
import type { SdkClientOptions } from '../lib/sdk-client.js';
import {
  MIN_RELAYFILE_VERSION,
  RelayfileControlPlaneClient,
  RelayfileControlPlaneError,
  assertRelayfileVersion,
  type RelayfileClientOptions,
} from '@relayfile/client';
import { resolveBaseUrl, resolveWorkspaceKey } from '../lib/sdk-client.js';

// Re-export the version gate so existing tests importing it from this module
// (and any callers) keep working after it moved to the published client package.
export { MIN_RELAYFILE_VERSION, assertRelayfileVersion };

export interface LocalRelayOptions {
  workspaceKey: string;
  baseUrl?: string;
}

export interface RelayfileBinding {
  provider: string;
  resource: string;
  channel: string;
  webhookId: string;
  subscriptionId: string;
  /** relayfile-cloud subscription that forwards provider records to the inbound webhook. */
  webhookSubscriptionId?: string;
  /** Workspace that subscription was created in — pins cleanup deletes across
   * active-workspace switches. */
  webhookSubscriptionWorkspaceId?: string;
}

export interface RelayfileResolvedResource {
  /** Canonical VFS path glob relayfile stores the binding under (begins with '/'). */
  pathGlob: string;
  /** Human-readable note when a wildcard fallback was used (resource not resolved exact). */
  warning?: string;
}

export interface RelayfileWritebackBinding {
  /** relayfile-cloud writeback ingress URL the subscription delivers to. */
  url: string;
  /** Per-channel HMAC secret the subscription signs deliveries with. */
  secret: string;
  /** Workspace that resolved this binding (daemons >= relayfile#346) — the
   * pre-create workspace pin for the cleanup journal. */
  workspaceId?: string;
}

export interface RelayfileWebhookSubscription {
  subscriptionId: string;
  secret?: string;
  /** Workspace the subscription was created in (daemons >= relayfile#346). */
  workspaceId?: string;
}

export interface RelayfileBridge {
  isConnected(provider: string): Promise<boolean>;
  connect(provider: string): Promise<void>;
  bind(input: {
    provider: string;
    resource: string;
    channel: string;
    webhookId: string;
    webhookToken: string;
    subscriptionId: string;
    webhookSubscriptionId: string;
    webhookSubscriptionWorkspaceId?: string;
  }): Promise<void>;
  listBindings(): Promise<RelayfileBinding[]>;
  unbind(provider: string, resource: string): Promise<void>;
  /**
   * Canonicalize a provider-native resource (Slack `#chan`, GitHub `owner/repo`,
   * Linear team key, …) to the VFS path glob relayfile actually keys the binding
   * on. relayfile stores bindings under the resolved glob, so callers MUST resolve
   * before matching/find/unbind or they will never hit the stored binding. The
   * resolution is idempotent: passing an already-resolved glob returns it
   * unchanged.
   */
  resolveResourcePath(provider: string, resource: string): Promise<RelayfileResolvedResource>;
  /**
   * Fail fast with an actionable message if the local `relayfile` binary is
   * missing or older than the version this CLI was built against — turning
   * contract drift into a startup error instead of a mid-operation surprise.
   */
  ensureCompatible(): Promise<void>;
  /**
   * Resolve the writeback ingress URL + per-channel signing secret for a relay
   * channel, fetched from relayfile-cloud over the authenticated relayfile
   * session. Returns undefined when it can't be determined (caller falls back to
   * --bridge-url / --bridge-secret). The secret is derived server-side, so the
   * subscription and the ingress agree on it without any static shared secret.
   */
  resolveWritebackBinding(channel: string): Promise<RelayfileWritebackBinding | undefined>;
  createWebhookSubscription(input: {
    url: string;
    pathGlobs: string[];
    secret: string;
    /** Pins the create to the pre-resolved workspace, so the created
     * subscription can never land in a workspace other than the one already
     * journaled in the attempt record. */
    workspace?: string;
  }): Promise<RelayfileWebhookSubscription>;
  /** `workspace` pins the delete to the workspace the subscription was
   * created in, guarding against active-workspace switches between runs. */
  deleteWebhookSubscription(subscriptionId: string, workspace?: string): Promise<void>;
  /**
   * Lists a workspace's inbound webhook subscriptions so crash-recovery can
   * find subscriptions whose server-assigned id was never persisted. Optional:
   * the published @relayfile/client v0.10.20 does not ship it, so the default
   * bridge exposes it only when the installed client does (see
   * defaultRelayfileBridge). Absent list capability, recovery falls back to
   * retaining attempt records and refusing same-key re-subscribes until the
   * v3 client is published and pinned.
   */
  listWebhookSubscriptions?: (workspace?: string) => Promise<{
    workspaceId?: string;
    subscriptions: Array<{ subscriptionId: string; url: string; pathGlobs: string[] }>;
  }>;
}

type RelayfileBindingInput = Parameters<RelayfileBridge['bind']>[0];

export type IntegrationCommandDependencies = SdkCommandDeps & {
  resolveLocalRelayOptions: () => Promise<LocalRelayOptions | undefined>;
  relayfile: RelayfileBridge;
  cleanupJournal: CleanupJournal;
  isInteractive: () => boolean;
  prompt: (question: string) => Promise<string>;
};

/**
 * Shared control-plane client for the default bridge. Lazily constructed so the
 * socket connection / daemon auto-start happens on first integration op, not at
 * import time. One instance is enough — it negotiates the daemon version once.
 */
let sharedClient: RelayfileControlPlaneClient | undefined;
const RELAYFILE_WEBHOOK_BINDINGS_API_VERSION = 3;
function controlPlaneClient(options?: RelayfileClientOptions): RelayfileControlPlaneClient {
  if (options) return new RelayfileControlPlaneClient(options);
  if (!sharedClient) sharedClient = new RelayfileControlPlaneClient();
  return sharedClient;
}

function readProviderConnected(payload: unknown, provider: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const CONNECTED_STATES = ['connected', 'ready', 'active', 'ok'];
  // Handle dict-keyed payloads where the provider name is the key
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const entry = Object.entries(record).find(
      ([key]) => key.trim().toLowerCase() === normalizedProvider
    )?.[1];
    if (entry && typeof entry === 'object') {
      const state = String(
        (entry as Record<string, unknown>).state ?? (entry as Record<string, unknown>).status ?? ''
      )
        .trim()
        .toLowerCase();
      if (CONNECTED_STATES.includes(state)) {
        return true;
      }
    }
  }
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? Object.values(payload as Record<string, unknown>)
      : [];
  return values.some((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const record = entry as Record<string, unknown>;
    const name = String(record.provider ?? record.name ?? record.id ?? '')
      .trim()
      .toLowerCase();
    const state = String(record.state ?? record.status ?? '')
      .trim()
      .toLowerCase();
    return name === normalizedProvider && CONNECTED_STATES.includes(state);
  });
}

/**
 * The default bridge talks to relayfile over the **control-plane unix socket**
 * (`relayfile control-plane serve`) via a typed client — NO `spawn('relayfile')`,
 * no stdout parsing. The daemon is auto-started on first use (or required running
 * under RELAYFILE_REQUIRE_DAEMON=1). The wire contract is version-negotiated, so
 * field/method drift is a typed error, not a silent runtime surprise.
 */
export function defaultRelayfileBridge(options?: RelayfileClientOptions): RelayfileBridge {
  const client = controlPlaneClient(options);
  return {
    async isConnected(provider) {
      const entry = await client.providerStatus(provider);
      if (!entry) return false;
      // provider-status returns the connection entry only when it's in the
      // connected set, but re-check its state to honor non-connected states.
      return readProviderConnected([entry], provider);
    },
    async connect(provider) {
      // OAuth runs in the daemon; on a local daemon the browser still opens
      // (noOpen defaults false). The returned output carries any connect URL.
      const { output } = await client.connect({ provider });
      if (output?.trim()) process.stderr.write(output.endsWith('\n') ? output : `${output}\n`);
    },
    async bind(input) {
      // TEMPORARY compatibility cast: registry @relayfile/client v0.10.20
      // forwards this object unchanged at runtime, but its published
      // BindRequest type predates control-plane API v3 and omits
      // webhookSubscriptionId. Remove once the v3 client (relayfile#346) is
      // published and pinned.
      await client.bind({
        provider: input.provider,
        resource: input.resource,
        channel: input.channel,
        webhookId: input.webhookId,
        webhookToken: input.webhookToken,
        subscriptionId: input.subscriptionId,
        webhookSubscriptionId: input.webhookSubscriptionId,
        ...(input.webhookSubscriptionWorkspaceId
          ? { webhookSubscriptionWorkspaceId: input.webhookSubscriptionWorkspaceId }
          : {}),
      } as Parameters<typeof client.bind>[0]);
    },
    async listBindings() {
      const bindings = await client.listBindings();
      // relayfile keys bindings on `pathGlob`; surface it as `resource` so callers
      // (find/unbind) match on the canonical glob.
      return bindings.map((b): RelayfileBinding => {
        // TEMPORARY compatibility cast (see bind() above): the published
        // Binding type omits the v3 field the daemon already returns. Remove
        // once the v3 client (relayfile#346) is published and pinned.
        const { webhookSubscriptionId, webhookSubscriptionWorkspaceId } = b as typeof b & {
          webhookSubscriptionId?: string;
          webhookSubscriptionWorkspaceId?: string;
        };
        return {
          provider: b.provider ?? '',
          resource: b.pathGlob ?? '',
          channel: b.channel ?? '',
          webhookId: b.webhookId ?? '',
          subscriptionId: b.subscriptionId ?? '',
          webhookSubscriptionId,
          webhookSubscriptionWorkspaceId,
        };
      });
    },
    async unbind(provider, resource) {
      await client.unbind(provider, resource);
    },
    async resolveResourcePath(provider, resource) {
      const resolved = await client.resolvePath(provider, resource);
      const pathGlob = resolved.pathGlob?.trim();
      if (!pathGlob) {
        throw new Error(`relayfile could not resolve a path glob for ${provider} "${resource}".`);
      }
      const warning = resolved.warning?.trim() || undefined;
      return warning ? { pathGlob, warning } : { pathGlob };
    },
    async ensureCompatible() {
      // Connecting negotiates the daemon version via /v1/hello; a too-old daemon
      // (or one that can't start) throws a typed, actionable error here.
      await client.ensureReady();
      const hello = await client.hello();
      if (!hello.supportedApiVersions?.includes(RELAYFILE_WEBHOOK_BINDINGS_API_VERSION)) {
        throw new RelayfileControlPlaneError(
          'VERSION_INCOMPATIBLE',
          `relayfile must support control-plane API v${RELAYFILE_WEBHOOK_BINDINGS_API_VERSION} to safely clean up inbound webhook subscriptions. Upgrade relayfile and retry.`
        );
      }
    },
    async resolveWritebackBinding(channel) {
      try {
        // TEMPORARY compatibility cast (see bind() above): daemons >= relayfile#346
        // include workspaceId, which the published v0.10.20 result type omits.
        const { url, secret, workspaceId } = (await client.writebackSecret(channel)) as {
          url?: string;
          secret?: string;
          workspaceId?: string;
        };
        if (!url?.trim() || !secret?.trim()) return undefined;
        return { url: url.trim(), secret: secret.trim(), workspaceId: workspaceId?.trim() || undefined };
      } catch (err) {
        // A missing/disconnected writeback secret is a soft miss (caller falls
        // back to --bridge-url/--bridge-secret). A daemon outage or version
        // incompatibility is NOT — re-throw those so the user sees the real
        // failure instead of a misleading "log in / pass --bridge-url" remedy.
        if (
          err instanceof RelayfileControlPlaneError &&
          (err.code === 'DAEMON_UNAVAILABLE' || err.code === 'VERSION_INCOMPATIBLE')
        ) {
          throw err;
        }
        return undefined;
      }
    },
    async createWebhookSubscription(input) {
      // TEMPORARY compatibility cast (see bind() above): daemons >= relayfile#346
      // return workspaceId, which the published v0.10.20 result type omits.
      const created = (await client.createWebhookSubscription(input)) as RelayfileWebhookSubscription & {
        workspaceId?: string;
      };
      return created;
    },
    async deleteWebhookSubscription(subscriptionId, workspace) {
      await client.deleteWebhookSubscription(subscriptionId, workspace);
    },
    // TEMPORARY runtime feature-detection: published @relayfile/client v0.10.20
    // has no listWebhookSubscriptions (a cast cannot conjure a missing runtime
    // method). Expose it only when the installed client ships it; collapse to
    // a plain method once the v3 client (relayfile#346) is published and pinned.
    ...(typeof (client as { listWebhookSubscriptions?: unknown }).listWebhookSubscriptions === 'function'
      ? {
          listWebhookSubscriptions: async (workspace?: string) => {
            const result = await (
              client as unknown as {
                listWebhookSubscriptions: (workspace?: string) => Promise<{
                  workspaceId?: string;
                  subscriptions?: Array<{
                    subscriptionId?: string;
                    url?: string;
                    pathGlobs?: string[];
                  }>;
                }>;
              }
            ).listWebhookSubscriptions(workspace);
            return {
              workspaceId: result.workspaceId,
              subscriptions: (result.subscriptions ?? []).map((s) => ({
                subscriptionId: s.subscriptionId ?? '',
                url: s.url ?? '',
                pathGlobs: s.pathGlobs ?? [],
              })),
            };
          },
        }
      : {}),
  };
}

async function promptLine(question: string): Promise<string> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function resolveLocalBrokerRelayOptions(): Promise<LocalRelayOptions | undefined> {
  let client:
    | {
        getSession: () => Promise<{ workspace_key?: string; relay_base_url?: string }>;
        disconnect?: () => void;
      }
    | undefined;
  try {
    const brokerClient = connectProjectBrokerClient(getProjectPaths().projectRoot);
    client = brokerClient;
    const session = await brokerClient.getSession();
    const workspaceKey = session.workspace_key?.trim();
    if (!workspaceKey) {
      return undefined;
    }
    const baseUrl = session.relay_base_url?.trim();
    return {
      workspaceKey,
      ...(baseUrl ? { baseUrl } : {}),
    };
  } catch {
    return undefined;
  } finally {
    client?.disconnect?.();
  }
}

function withIntegrationDefaults(
  overrides: Partial<IntegrationCommandDependencies> = {}
): IntegrationCommandDependencies {
  return {
    ...withSdkDefaults(overrides),
    resolveLocalRelayOptions: resolveLocalBrokerRelayOptions,
    relayfile: defaultRelayfileBridge(),
    cleanupJournal: fileCleanupJournal(),
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: promptLine,
    ...overrides,
  };
}

function explicitWorkspaceKey(opts: Record<string, unknown>): boolean {
  return typeof opts.workspaceKey === 'string' && opts.workspaceKey.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function shouldRetryWithLocalWorkspaceKey(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /invalid (api|workspace) key/i.test(message) ||
    /no workspace key found/i.test(message) ||
    /unauthorized/i.test(message)
  );
}

function localRetryOptions(options: SdkClientOptions, local: LocalRelayOptions): SdkClientOptions {
  return {
    ...options,
    workspaceKey: local.workspaceKey,
    baseUrl: options.baseUrl ?? local.baseUrl,
  };
}

function parseFilter(raw: string): Record<string, string> {
  const [key, ...rest] = raw.split('=');
  const trimmedKey = key?.trim();
  if (!trimmedKey || rest.length === 0) {
    throw new Error('Invalid --filter value. Expected key=value, for example channel=#ops.');
  }
  return { [trimmedKey]: rest.join('=').trim() };
}

function commaList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Resolve the writeback delivery URL + signing secret for the relay
 * subscription. Both come from relayfile-cloud (workspace-scoped ingress URL +
 * the per-channel derived secret), fetched over the authenticated relayfile
 * session — so the subscription and the ingress agree on the secret with
 * nothing to provision.
 *
 * Precedence: explicit --bridge-url/--bridge-secret override each field; the
 * fetched binding fills the rest. Throws with remediation when a field can't be
 * resolved, so we never create a subscription with a dead URL or an
 * unverifiable secret.
 */
async function resolveWriteback(
  deps: IntegrationCommandDependencies,
  commandOpts: Record<string, unknown>,
  channel: string
): Promise<{ url: string; secret: string; workspaceId?: string }> {
  const explicitUrl = typeof commandOpts.bridgeUrl === 'string' ? commandOpts.bridgeUrl.trim() : '';
  const explicitSecret = typeof commandOpts.bridgeSecret === 'string' ? commandOpts.bridgeSecret.trim() : '';

  if ((explicitUrl && !explicitSecret) || (!explicitUrl && explicitSecret)) {
    throw new Error(
      '--bridge-url and --bridge-secret must be provided together; providing only one is not supported.'
    );
  }

  if (explicitUrl && explicitSecret) {
    return { url: explicitUrl, secret: explicitSecret };
  }

  const binding = await deps.relayfile.resolveWritebackBinding(channel);
  if (!binding?.url) {
    throw new Error(
      'Could not resolve the relayfile writeback ingress URL. Ensure relayfile is ' +
        'logged in (relayfile login), or pass --bridge-url and --bridge-secret.'
    );
  }
  if (!binding?.secret) {
    throw new Error(
      'Could not resolve the writeback signing secret. Ensure relayfile is logged ' +
        'in (relayfile login) and supports `integration writeback-secret`, or pass --bridge-url and --bridge-secret.'
    );
  }
  return { url: binding.url, secret: binding.secret, workspaceId: binding.workspaceId };
}

async function createRelayfileInboundTarget(
  commandOpts: Record<string, unknown>,
  local: LocalRelayOptions | undefined,
  input: { channel: string; provider: string; pathGlob: string }
): Promise<{ url: string; secret: string }> {
  const options = sdkOptionsFromOpts(commandOpts);
  const authOptions =
    local && !explicitWorkspaceKey(commandOpts) ? localRetryOptions(options, local) : options;
  const workspaceKey = resolveWorkspaceKey(authOptions);
  const baseUrl = resolveInboundTargetBaseUrl(options);
  const response = await fetch(new URL('/v1/integrations/relayfile/inbound-target', baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${workspaceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: input.channel,
      provider: input.provider,
      pathGlob: input.pathGlob,
    }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message =
      isRecord(body) && typeof body.message === 'string'
        ? body.message
        : `relaycast returned ${response.status}`;
    throw new Error(`Could not create relayfile inbound target: ${message}`);
  }
  return parseRelayfileInboundTargetResponse(body);
}

function parseRelayfileInboundTargetResponse(body: unknown): { url: string; secret: string } {
  const data = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(data) || typeof data.url !== 'string' || typeof data.secret !== 'string') {
    throw new Error('relaycast returned an invalid relayfile inbound target response');
  }
  const url = data.url.trim();
  const secret = data.secret.trim();
  if (!url || !secret) {
    throw new Error('relaycast returned an invalid relayfile inbound target response');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('relaycast returned an invalid relayfile inbound target URL');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('relaycast returned a non-https relayfile inbound target URL');
  }
  return { url: parsedUrl.toString(), secret };
}

function resolveInboundTargetBaseUrl(options: SdkClientOptions): string {
  const baseUrl = resolveBaseUrl(options) ?? 'https://cast.agentrelay.com';
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('Inbound relayfile target provisioning requires an https Relaycast base URL.');
  }
  return parsed.toString();
}

function targetChannel(target: string): string {
  const trimmed = target.trim();
  // Strip the leading sigil so the channel id is canonical (`general`, not
  // `#general`/`@general`) across the webhook name, subscription filter,
  // relayfile bind, and writeback-secret lookup.
  return trimmed.startsWith('@') || trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
}

function agentName(target: string): string | undefined {
  const trimmed = target.trim();
  return trimmed.startsWith('@') ? trimmed.slice(1).trim() : undefined;
}

async function ensureProviderConnected(
  deps: IntegrationCommandDependencies,
  provider: string,
  opts: Record<string, unknown>
): Promise<void> {
  if (await deps.relayfile.isConnected(provider)) {
    return;
  }

  if (opts.input === false || !deps.isInteractive()) {
    throw new Error(
      `${provider} isn't connected to this workspace yet.\nRun: relayfile integration connect ${provider} --workspace <ws>, then re-run.`
    );
  }

  deps.log(`${provider} isn't connected to this workspace yet.`);
  deps.log(`Opening browser to connect ${provider}...`);
  await deps.relayfile.connect(provider);
  if (!(await deps.relayfile.isConnected(provider))) {
    throw new Error(
      `${provider} is still not connected. Run: relayfile integration connect ${provider} --workspace <ws>, then re-run.`
    );
  }
}

async function ensureRecipient(
  relay: AgentRelayAgent,
  provider: string,
  target: string,
  opts: Record<string, unknown>
): Promise<void> {
  const name = agentName(target);
  if (!name) {
    return;
  }
  const agents = await relay.agents.list();
  if (agents.some((agent: { name: string }) => agent.name === name)) {
    return;
  }

  const spawnCli = typeof opts.spawn === 'string' ? opts.spawn.trim() : '';
  if (!spawnCli) {
    throw new Error(
      `Recipient agent ${target} does not exist. Run: agent-relay integration subscribe ${provider} --to ${target} --spawn <cli>`
    );
  }

  await relay.agents.register({
    name,
    type: 'agent',
    metadata: { requestedCli: spawnCli, source: 'integration.subscribe' },
  });
}

async function promptSubscribeOptions(
  deps: IntegrationCommandDependencies,
  provider: string | undefined,
  opts: Record<string, unknown>
): Promise<{ provider: string; resource: string; to: string }> {
  if (provider && typeof opts.resource === 'string' && typeof opts.to === 'string') {
    return { provider, resource: opts.resource, to: opts.to };
  }
  if (opts.input === false || !deps.isInteractive()) {
    throw new Error(
      'Non-interactive subscribe requires <provider>, --resource <value>, and --to <agent|#channel>.'
    );
  }
  const resolvedProvider = provider ?? (await deps.prompt('Integration provider: '));
  const resource =
    typeof opts.resource === 'string' && opts.resource.trim()
      ? opts.resource
      : await deps.prompt('Provider resource: ');
  const to = typeof opts.to === 'string' && opts.to.trim() ? opts.to : await deps.prompt('Relay recipient: ');
  return { provider: resolvedProvider, resource, to };
}

async function runIntegrationOperation<T>(
  deps: IntegrationCommandDependencies,
  commandOpts: Record<string, unknown>,
  operation: (relay: AgentRelayAgent) => Promise<T>
): Promise<T> {
  const options = sdkOptionsFromOpts(commandOpts);
  try {
    return await operation(deps.createAgentRelay(options));
  } catch (error) {
    if (explicitWorkspaceKey(commandOpts) || !shouldRetryWithLocalWorkspaceKey(error)) {
      throw error;
    }

    const local = await deps.resolveLocalRelayOptions();
    if (!local) {
      throw error;
    }

    return await operation(deps.createAgentRelay(localRetryOptions(options, local)));
  }
}

/**
 * Stable per-(provider, resource) prefix for the inbound webhook name. The
 * webhook's true identity is the binding it backs — (provider, resource) — not
 * the relay channel, so two resources routed to the same channel get distinct
 * webhooks and never clobber each other. A short hash keeps the name unique and
 * charset-safe while a slug stem keeps it recognizable in `webhook list-inbound`.
 */
function webhookNamePrefix(provider: string, resource: string): string {
  const hash = createHash('sha1').update(resource).digest('hex').slice(0, 10);
  const slug = resource
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return slug ? `relayfile:${provider}:${slug}-${hash}` : `relayfile:${provider}:${hash}`;
}

/** Unique inbound webhook name for a single subscribe attempt. The trailing
 * nonce lets us create the replacement webhook before deleting the old one
 * without tripping the unique (workspace, name) index. */
function inboundWebhookName(prefix: string): string {
  return `${prefix}:${randomBytes(5).toString('hex')}`;
}

function isAlreadyDeletedWebhookSubscription(err: unknown): boolean {
  return err instanceof RelayfileControlPlaneError && err.status === 404;
}

/** Relaycast SDK errors expose statusCode/status; a not-found delete means the
 * resource is already gone — the retry must converge, not persist forever. */
function isNotFoundRelayError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { statusCode, status } = err as { statusCode?: unknown; status?: unknown };
  return statusCode === 404 || status === 404;
}

/**
 * Non-secret identity of the relay connection a journal entry may retry
 * through. The workspace key is a credential, so it is run through a
 * purpose-domain PBKDF2 (never a bare hash — CodeQL
 * js/insufficient-password-hash) with the base URL as the salt domain; only
 * the derived digest is ever stored.
 */
export function relayCleanupScope(options: SdkClientOptions): string {
  let workspaceKey = '';
  try {
    workspaceKey = resolveWorkspaceKey(options);
  } catch {
    // No resolvable key: scope on the base URL alone. Entries recorded this
    // way still never leak the key (only a derived digest is stored).
  }
  const digest = pbkdf2Sync(
    workspaceKey,
    `agent-relay:cleanup-scope:${resolveBaseUrl(options) ?? ''}`,
    10_000,
    8,
    'sha256'
  ).toString('hex');
  return `relay:${digest}`;
}

/** The default bridge always talks to the project-local relayfile daemon; the
 * per-entry relayfileWorkspaceId pin (not this scope) guards against active
 * workspace switches between runs. */
function relayfileCleanupScope(): string {
  return 'relayfile:project-daemon';
}

/**
 * Bounded lease window for entry owners, set safely ABOVE every remote
 * request timeout any lifecycle or recovery performs (each spans seconds; a
 * reconciliation at most a few request timeouts). Explicit bounded-lease
 * tradeoff: a process paused (e.g. SIGSTOP) past this window loses its
 * lease and a rival may proceed — accepted deliberately, because the
 * alternative (pure pid probing) lets PID reuse wedge lifecycles FOREVER.
 */
/**
 * Lease timing knobs, exported as one mutable object ONLY so tests can run
 * deterministic renewal scenarios with tiny windows; production code never
 * mutates it. renewalMs sits well below leaseMs so an active lifecycle
 * refreshes its lease several times per window.
 */
export const OWNER_LEASE_CONFIG = {
  leaseMs: 15 * 60_000,
  renewalMs: 5 * 60_000,
  /** Tolerated forward clock skew. A heartbeat further in the FUTURE than
   * this is malformed or from a skewed clock and counts as expired —
   * otherwise a finite future value (e.g. 9e15) would make its owner live
   * forever and unbound the lease again. */
  skewMs: 2 * 60_000,
};

/** A journal entry lease-owner is live ONLY while its bounded lease is
 * fresh AND (same host) its pid probes alive. The heartbeat bound is what
 * makes PID reuse — which can make a dead owner's pid probe pass forever —
 * and unprobeable foreign-host owners an availability delay of at most
 * OWNER_LEASE_MS, never a permanent wedge. Within the window, an alive
 * probe or a foreign host still fails closed. */
function isOwnerLive(owner: PendingCleanupOwner | undefined): boolean {
  if (!owner) return false;
  const age = Date.now() - owner.heartbeatAt;
  if (age > OWNER_LEASE_CONFIG.leaseMs) return false; // lease expired
  if (age < -OWNER_LEASE_CONFIG.skewMs) return false; // future-dated beyond skew: bounded, not immortal
  if (owner.host !== hostname()) return true; // cannot prove death — fail closed within the lease
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function newCleanupOwner(): PendingCleanupOwner {
  return {
    pid: process.pid,
    host: hostname(),
    attemptId: randomBytes(8).toString('hex'),
    heartbeatAt: Date.now(),
  };
}

/**
 * Periodic lease renewal for an owned journal record: an unref'd timer
 * atomically re-stamps heartbeatAt on entries owned by exactly this
 * attemptId, so a legitimate lifecycle awaiting external operations past
 * OWNER_LEASE_CONFIG.leaseMs keeps a LIVE reservation (a paused event loop
 * past the bound remains the documented tradeoff). Started only after the
 * reservation is durably acquired; MUST be stopped before the record is
 * cleared on every exit path. A renewal failure latches: assertHealthy()
 * then throws so later lifecycle mutations/commits never proceed blindly on
 * a possibly-lost lease.
 */
function startLeaseRenewal(
  deps: IntegrationCommandDependencies,
  attemptId: string
): { stop(): void; assertHealthy(context: string): void } {
  let failed: string | undefined;
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing || failed) return;
    renewing = true;
    let matched = 0;
    deps.cleanupJournal
      .update((entries) =>
        entries.map((entry) => {
          if (entry.owner?.attemptId !== attemptId) return entry;
          matched += 1;
          return { ...entry, owner: { ...entry.owner, heartbeatAt: Date.now() } };
        })
      )
      .then(() => {
        if (matched === 0) {
          // The owned record is GONE — the lease was lost (e.g. reclaimed);
          // latch so no further external mutation proceeds on it.
          failed = 'reservation record no longer present';
          deps.error(
            'Warning: the lifecycle lease record disappeared during renewal; aborting before any further external mutation.'
          );
        }
      })
      .catch((err) => {
        failed = err instanceof Error ? err.message : String(err);
        deps.error(
          'Warning: could not renew the lifecycle lease; aborting before any further external mutation.'
        );
      })
      .finally(() => {
        renewing = false;
      });
  }, OWNER_LEASE_CONFIG.renewalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
    assertHealthy(context: string) {
      if (failed) {
        throw new Error(
          `The lifecycle lease for ${context} could not be renewed (${failed}); aborting instead of proceeding on a possibly-lost reservation.`
        );
      }
    },
  };
}

function sameGlobSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((glob, i) => glob === right[i]);
}

/**
 * Record cleanup work that already exists remotely (the mutation happened; a
 * journal failure here can only be surfaced, not used to abort). Returns
 * whether the entry is durably recorded. Never logs entry urls or ids — the
 * journal file is their only home.
 */
async function tryRecordCleanup(
  deps: IntegrationCommandDependencies,
  entry: PendingCleanupEntry,
  context: string
): Promise<boolean> {
  try {
    await deps.cleanupJournal.update((entries) =>
      entries.some((existing) => cleanupEntryKey(existing) === cleanupEntryKey(entry))
        ? entries
        : [...entries, entry]
    );
    deps.error(
      `Warning: could not clean up a ${describeCleanupKind(entry.kind)} for ${context}; recorded for retry on a later run.`
    );
    return true;
  } catch (journalErr) {
    deps.error(
      `Warning: could not clean up a ${describeCleanupKind(entry.kind)} for ${context} AND could not record it for retry (${
        journalErr instanceof Error ? journalErr.message : String(journalErr)
      }).`
    );
    return false;
  }
}

function describeCleanupKind(kind: PendingCleanupEntry['kind']): string {
  switch (kind) {
    case 'relayfile-webhook-subscription':
      return 'relayfile webhook subscription';
    case 'relay-webhook':
      return 'relay inbound webhook';
    case 'relay-subscription':
      return 'relay event subscription';
    case 'subscribe-attempt':
      return 'subscribe attempt';
  }
}

async function removeCleanupEntry(
  deps: IntegrationCommandDependencies,
  entry: PendingCleanupEntry
): Promise<void> {
  await deps.cleanupJournal.update((entries) =>
    entries.filter((existing) => cleanupEntryKey(existing) !== cleanupEntryKey(entry))
  );
}

/**
 * Retry every journal entry the current run's connections can act on. Runs on
 * each subscribe/unsubscribe before that run's own lifecycle mutations.
 *
 * Guards: an entry whose lease-owner is live (or unprovable) is untouched —
 * it belongs to an in-flight transaction; entries from other scopes are
 * untouched; ids referenced by an active binding or the caller's keep-set are
 * never deleted; cloud deletes are pinned to the entry's recorded workspace
 * and a cloud 404 only converges when pinned (an unpinned 404 might be the
 * wrong active workspace, so the entry is retained); attempt reconciliation
 * needs the (optional) list capability. Failures keep the entry. Never logs
 * entry urls or ids.
 */
async function sweepPendingCleanups(
  deps: IntegrationCommandDependencies,
  relay: AgentRelayAgent | undefined,
  options: {
    relayScope?: string;
    relayfileScope: string;
    keepWebhookSubscriptionId?: string;
    keepWebhookId?: string;
  }
): Promise<void> {
  let entries: PendingCleanupEntry[];
  let bindings: RelayfileBinding[];
  try {
    [entries, bindings] = await Promise.all([deps.cleanupJournal.list(), deps.relayfile.listBindings()]);
  } catch {
    return; // fail closed: unknown journal or binding state sweeps nothing
  }
  if (entries.length === 0) return;

  const activeWebhookSubscriptionIds = new Set(
    bindings.map((b) => b.webhookSubscriptionId).filter((id): id is string => Boolean(id))
  );
  if (options.keepWebhookSubscriptionId) activeWebhookSubscriptionIds.add(options.keepWebhookSubscriptionId);
  const activeWebhookIds = new Set(bindings.map((b) => b.webhookId).filter(Boolean));
  if (options.keepWebhookId) activeWebhookIds.add(options.keepWebhookId);
  const activeSubscriptionIds = new Set(bindings.map((b) => b.subscriptionId).filter(Boolean));

  const deleteCloudSubscription = async (
    id: string,
    workspace: string | undefined
  ): Promise<'deleted' | 'retained'> => {
    try {
      await deps.relayfile.deleteWebhookSubscription(id, workspace);
      return 'deleted';
    } catch (err) {
      if (isAlreadyDeletedWebhookSubscription(err) && workspace) return 'deleted';
      if (isAlreadyDeletedWebhookSubscription(err)) return 'retained'; // unpinned 404: maybe wrong workspace
      throw err;
    }
  };

  for (const entry of entries) {
    if (isOwnerLive(entry.owner)) continue; // an in-flight transaction's lease
    try {
      switch (entry.kind) {
        case 'relayfile-webhook-subscription': {
          if (entry.scope !== options.relayfileScope || !entry.id) continue;
          if (activeWebhookSubscriptionIds.has(entry.id)) continue;
          if ((await deleteCloudSubscription(entry.id, entry.relayfileWorkspaceId)) === 'retained') {
            continue;
          }
          await removeCleanupEntry(deps, entry);
          deps.log('Retired a relayfile webhook subscription from an earlier failed cleanup.');
          break;
        }
        case 'subscribe-attempt': {
          if (entry.scope !== options.relayfileScope) continue;
          if (entry.operation === 'unsubscribe') {
            // An unsubscribe reservation creates nothing; a dead one has
            // nothing to recover (its failures were recorded as ownerless
            // concrete entries) and is simply released.
            await removeCleanupEntry(deps, entry);
            break;
          }
          // CLAIM the stale attempt as this process's live recovery lease
          // BEFORE any remote list/delete. Recovery then holds the same
          // per-resource lease new lifecycles reserve under (prepare aborts
          // on a live owner), so a new subscribe can never create a same-key
          // pre-bind resource while this reconciliation is mid-flight — and
          // if the entry vanished or was claimed meanwhile, recovery skips.
          const recoveryOwner = newCleanupOwner();
          let claimed = false;
          await deps.cleanupJournal.update((fresh) => {
            const index = fresh.findIndex(
              (candidate) => cleanupEntryKey(candidate) === cleanupEntryKey(entry)
            );
            if (index < 0 || isOwnerLive(fresh[index]!.owner)) return fresh;
            claimed = true;
            const next = [...fresh];
            next[index] = { ...next[index]!, owner: recoveryOwner };
            return next;
          });
          if (!claimed) break;
          const claimedEntry: PendingCleanupEntry = { ...entry, owner: recoveryOwner };
          const releaseClaim = () =>
            deps.cleanupJournal
              .update((fresh) =>
                fresh.map((candidate) =>
                  cleanupEntryKey(candidate) === cleanupEntryKey(claimedEntry)
                    ? { ...candidate, owner: entry.owner }
                    : candidate
                )
              )
              .catch(() => undefined);
          try {
            let cloudResolved = false;
            // Cloud side: a concrete id beats list-matching; both are pinned to
            // the attempt's recorded workspace when known.
            if (
              entry.webhookSubscriptionId &&
              !activeWebhookSubscriptionIds.has(entry.webhookSubscriptionId)
            ) {
              cloudResolved =
                (await deleteCloudSubscription(entry.webhookSubscriptionId, entry.relayfileWorkspaceId)) ===
                'deleted';
            } else if (entry.webhookSubscriptionId) {
              cloudResolved = true; // bound and active — nothing to clean
            } else if (deps.relayfile.listWebhookSubscriptions && entry.relayfileWorkspaceId) {
              // Only a workspace-pinned attempt may list-reconcile: an unpinned
              // list would query whatever workspace is active NOW and could
              // falsely settle an attempt whose create landed elsewhere.
              const listed = await deps.relayfile.listWebhookSubscriptions(entry.relayfileWorkspaceId);
              if (listed.workspaceId !== entry.relayfileWorkspaceId) {
                // Fail closed unless the daemon EXPLICITLY confirms it answered
                // for the pinned workspace — a missing echo is not good enough.
                cloudResolved = false;
              } else {
                const orphans = listed.subscriptions.filter(
                  (subscription) =>
                    subscription.url === entry.url &&
                    sameGlobSet(subscription.pathGlobs, entry.pathGlobs) &&
                    !activeWebhookSubscriptionIds.has(subscription.subscriptionId)
                );
                for (const orphan of orphans) {
                  await deleteCloudSubscription(orphan.subscriptionId, entry.relayfileWorkspaceId);
                }
                cloudResolved = true;
              }
            }
            // Relay side: recover by concrete id or deterministic key.
            const relayResolved = Boolean(relay) && entry.relayScope === options.relayScope;
            if (relay && entry.relayScope === options.relayScope) {
              const webhookIds = new Set<string>();
              if (entry.webhookId) {
                webhookIds.add(entry.webhookId);
              } else if (entry.webhookName) {
                // Exact-name match only: a prefix match could hit a DIFFERENT
                // attempt's pre-bind webhook for the same resource.
                const hooks = await relay.webhooks.list();
                for (const hook of hooks) {
                  if (hook.name === entry.webhookName && !activeWebhookIds.has(hook.webhookId)) {
                    webhookIds.add(hook.webhookId);
                  }
                }
              }
              for (const webhookId of webhookIds) {
                if (activeWebhookIds.has(webhookId)) continue;
                try {
                  await relay.webhooks.delete(webhookId);
                } catch (err) {
                  if (!isNotFoundRelayError(err)) throw err;
                }
              }
              if (entry.subscriptionId) {
                if (!activeSubscriptionIds.has(entry.subscriptionId)) {
                  try {
                    await relay.webhooks.unsubscribe(entry.subscriptionId);
                  } catch (err) {
                    if (!isNotFoundRelayError(err)) throw err;
                  }
                }
              } else if (entry.writebackUrl) {
                // The attempt's subscription targeted the writeback url with a
                // per-attempt marker appended, so an exact-url match can only be
                // THIS dead attempt's subscription — never another attempt's on
                // the same channel. The active-id guard stays as belt.
                const subscriptions = await relay.webhooks.subscriptions();
                for (const subscription of subscriptions) {
                  if (
                    subscription.url === entry.writebackUrl &&
                    !activeSubscriptionIds.has(subscription.id)
                  ) {
                    try {
                      await relay.webhooks.unsubscribe(subscription.id);
                    } catch (err) {
                      if (!isNotFoundRelayError(err)) throw err;
                    }
                  }
                }
              }
            }
            if (cloudResolved && relayResolved) {
              await removeCleanupEntry(deps, claimedEntry);
              deps.log(
                `Reconciled resources left by an interrupted subscribe of ${entry.provider ?? 'unknown'} ${entry.resource ?? ''}.`
              );
            } else {
              // Partial: hand the lease back to its (dead) owner so a later
              // sweep — including one in this same process — can reclaim it.
              await releaseClaim();
            }
          } catch (err) {
            await releaseClaim();
            throw err;
          }
          break;
        }

        case 'relay-webhook': {
          if (!relay || entry.scope !== options.relayScope || !entry.id) continue;
          if (activeWebhookIds.has(entry.id)) continue;
          try {
            await relay.webhooks.delete(entry.id);
          } catch (err) {
            // 404: an earlier delete succeeded remotely but its response was
            // lost — the entry has converged and must not be retained forever.
            if (!isNotFoundRelayError(err)) throw err;
          }
          await removeCleanupEntry(deps, entry);
          deps.log('Retired a relay inbound webhook from an earlier failed cleanup.');
          break;
        }
        case 'relay-subscription': {
          if (!relay || entry.scope !== options.relayScope || !entry.id) continue;
          if (activeSubscriptionIds.has(entry.id)) continue;
          try {
            await relay.webhooks.unsubscribe(entry.id);
          } catch (err) {
            if (!isNotFoundRelayError(err)) throw err;
          }
          await removeCleanupEntry(deps, entry);
          deps.log('Retired a relay event subscription from an earlier failed cleanup.');
          break;
        }
      }
    } catch {
      deps.error(
        `Warning: a recorded ${describeCleanupKind(entry.kind)} cleanup still failed; it stays recorded for the next run.`
      );
    }
  }
}

/**
 * The relayfile binding currently backing this (provider, pathGlob), if any.
 * `pathGlob` MUST be the resolved VFS glob (see resolveResourcePath) — `listBindings`
 * returns bindings keyed on the glob, so matching on a native resource never hits.
 */
async function findExistingBinding(
  deps: IntegrationCommandDependencies,
  provider: string,
  pathGlob: string
): Promise<RelayfileBinding | undefined> {
  // Fail fast: this runs before any mutation, so if we can't read the binding
  // store we must abort rather than mistake a read failure for "no prior
  // binding" and create a duplicate. (An empty/absent store resolves to [].)
  const bindings = await deps.relayfile.listBindings();
  return bindings.find((item) => item.provider === provider && item.resource === pathGlob);
}

/**
 * Retire webhooks/subscriptions that the freshly-created binding superseded,
 * run only after the new binding is fully in place so a transient failure can
 * never leave the user with no working binding. Removes, by id and best-effort:
 *
 * - the prior binding's webhook + subscription (handles legacy
 *   `relayfile:<provider>` names regardless of channel sigil);
 * - webhooks orphaned by earlier partial runs of *this same* resource (matched
 *   by the resource-scoped name prefix, so other resources are never touched);
 * - a legacy un-scoped `relayfile:<provider>` webhook only when no active
 *   binding references it.
 */
async function retireSupersededWebhooks(
  deps: IntegrationCommandDependencies,
  relay: AgentRelayAgent,
  options: {
    provider: string;
    resource: string;
    prefix: string;
    keepWebhookId: string;
    keepWebhookSubscriptionId: string;
    priorBinding: RelayfileBinding | undefined;
    relayScope: string;
    relayfileScope: string;
  }
): Promise<void> {
  const { provider, resource, prefix, keepWebhookId, keepWebhookSubscriptionId, priorBinding } = options;

  // The prior binding's ids were pre-recorded in the journal BEFORE bind()
  // overwrote their only other persisted home (see prepareSubscribeIntent), so
  // a failed delete here needs no recording — the entry simply stays; a
  // successful delete clears it.
  if (priorBinding && priorBinding.subscriptionId) {
    const entry: PendingCleanupEntry = {
      kind: 'relay-subscription',
      scope: options.relayScope,
      id: priorBinding.subscriptionId,
    };
    try {
      await relay.webhooks.unsubscribe(priorBinding.subscriptionId);
      // A failed remove only leaves a lingering entry; the 404-tolerant sweep
      // self-heals it, so it must not fail the already-successful subscribe.
      await removeCleanupEntry(deps, entry).catch(() => undefined);
    } catch (err) {
      if (isNotFoundRelayError(err)) {
        await removeCleanupEntry(deps, entry).catch(() => undefined);
      } else {
        deps.error(
          `Warning: could not retire the prior relay event subscription for ${provider} ${resource}; it stays recorded for a later run.`
        );
      }
    }
  }

  const priorWebhookSubId = priorBinding?.webhookSubscriptionId;
  if (priorWebhookSubId && priorWebhookSubId !== keepWebhookSubscriptionId) {
    const priorWorkspaceId = priorBinding?.webhookSubscriptionWorkspaceId;
    const entry: PendingCleanupEntry = {
      kind: 'relayfile-webhook-subscription',
      scope: options.relayfileScope,
      id: priorWebhookSubId,
      ...(priorWorkspaceId ? { relayfileWorkspaceId: priorWorkspaceId } : {}),
    };
    try {
      await deps.relayfile.deleteWebhookSubscription(priorWebhookSubId, priorWorkspaceId);
      await removeCleanupEntry(deps, entry).catch(() => undefined);
    } catch (err) {
      // A 404 only converges when the delete was workspace-pinned; an
      // unpinned "not found" might just mean the daemon's active workspace
      // changed. Either way the pre-recorded entry stays until attributable.
      if (isAlreadyDeletedWebhookSubscription(err) && priorWorkspaceId) {
        await removeCleanupEntry(deps, entry).catch(() => undefined);
      } else {
        deps.error(
          `Warning: could not retire the prior relayfile webhook subscription for ${provider} ${resource}; it stays recorded for a later run.`
        );
      }
    }
  }

  await sweepPendingCleanups(deps, relay, {
    relayScope: options.relayScope,
    relayfileScope: options.relayfileScope,
    keepWebhookSubscriptionId,
    keepWebhookId,
  });

  let webhooks: Awaited<ReturnType<typeof relay.webhooks.list>>;
  let activeWebhookIds: Set<string>;
  try {
    const [list, bindings] = await Promise.all([relay.webhooks.list(), deps.relayfile.listBindings()]);
    webhooks = list;
    activeWebhookIds = new Set(bindings.map((binding) => binding.webhookId));
  } catch {
    return; // best-effort hygiene; the new binding is already live
  }

  // Deletion here is strictly ATTRIBUTABLE: the prior binding's exact webhook
  // id and the unbound legacy fixed name. Broad same-prefix orphan deletion
  // was removed — a concurrent attempt's pre-bind webhook shares the prefix
  // and no snapshot ordering can make deleting it provably safe, while every
  // attributable orphan is already covered by the prior id, the journaled
  // exact attempt names, or recorded relay-webhook entries. An unattributable
  // ancient orphan is leaked rather than risked.
  const legacyName = `relayfile:${provider}`;
  for (const hook of webhooks) {
    // Never delete a webhook an active binding references — that includes the
    // one we just bound, and guards against a concurrent re-subscribe that
    // upserted a newer binding between our bind and this sweep.
    if (hook.webhookId === keepWebhookId || activeWebhookIds.has(hook.webhookId)) continue;
    const isPrior = priorBinding?.webhookId === hook.webhookId;
    const isUnboundLegacy = hook.name === legacyName;
    if (!isPrior && !isUnboundLegacy) continue;
    // A failed delete here needs no journal entry: this same sweep re-discovers
    // the webhook by name/binding on the next run. Logs stay id-free — the
    // human-meaningful webhook NAME identifies it for operators.
    await relay.webhooks
      .delete(hook.webhookId)
      .then(() => deps.log(`Retired superseded webhook ${hook.name ?? 'unnamed'}.`))
      .catch(() =>
        deps.error(
          `Warning: failed to retire superseded webhook ${hook.name ?? 'unnamed'}; the next subscribe run retries it.`
        )
      );
  }
}

/**
 * Enforce the crash-window contract before ANY external create.
 *
 * 1. Retry all recorded cleanup work first (every subscribe run sweeps).
 * 2. A retained attempt with the same (scope, provider, resource, url, glob
 *    set) after the sweep is either a LIVE concurrent transaction (its
 *    lease-owner is alive — abort rather than interleave with it) or an
 *    interrupted one that could not be reconciled (no list capability on the
 *    published v0.10.20 client, or the daemon/cloud unreachable — abort
 *    rather than double-subscribe).
 * 3. Journal, in ONE atomic write, this run's owner-leased attempt record
 *    (whose deterministic keys can recover all three creates after a crash)
 *    AND the prior binding's non-rediscoverable ids — bind() is about to
 *    overwrite their only other persisted home. Until then the sweep's
 *    active-binding guard keeps the pre-recorded ids untouchable. Any journal
 *    failure aborts the run (nothing external has been created yet).
 */
async function prepareSubscribeAttempt(
  deps: IntegrationCommandDependencies,
  relay: AgentRelayAgent,
  attempt: PendingCleanupEntry,
  channel: string,
  scopes: { relayScope: string; relayfileScope: string }
): Promise<void> {
  // Ownership conflicts match on the durable binding identity ONLY — a
  // regenerated inbound-target url or glob spelling must not let two
  // same-resource lifecycles run concurrently. (url/globs remain the cloud
  // RECOVERY keys, not the ownership key.)
  const matchesAttemptKey = (entry: PendingCleanupEntry): boolean =>
    entry.kind === 'subscribe-attempt' &&
    entry.scope === attempt.scope &&
    entry.provider === attempt.provider &&
    entry.resource === attempt.resource;

  await sweepPendingCleanups(deps, relay, scopes);

  // Pin the exact relayfile workspace BEFORE any cloud create: a crash after
  // the create reaches the server but before its response would otherwise
  // leave the attempt unpinned, and an unpinned list/delete after an
  // active-workspace switch could falsely settle it. The pin is MANDATORY on
  // every path — no pin, no create. writeback-secret resolution (daemons >=
  // relayfile#346) provides it normally (the published v0.10.20 client
  // runtime preserves the extra JSON field); with --bridge-url/--bridge-secret
  // overrides the control plane is still consulted for the workspace alone,
  // then the v3 list, and a run that cannot obtain a pin aborts here.
  if (!attempt.relayfileWorkspaceId) {
    // Even with explicit --bridge-url/--bridge-secret overrides, the control
    // plane is still consulted for the workspace identity alone.
    const resolved = await deps.relayfile.resolveWritebackBinding(channel).catch(() => undefined);
    if (resolved?.workspaceId) attempt.relayfileWorkspaceId = resolved.workspaceId;
  }
  if (!attempt.relayfileWorkspaceId && deps.relayfile.listWebhookSubscriptions) {
    const { workspaceId } = await deps.relayfile.listWebhookSubscriptions();
    if (workspaceId) attempt.relayfileWorkspaceId = workspaceId;
  }
  if (!attempt.relayfileWorkspaceId) {
    // No pin, no create: an unpinned cloud subscription would be unretryable
    // across an active-workspace switch.
    throw new Error(
      `Could not determine the active relayfile workspace before subscribing ${attempt.provider} ${attempt.resource}; upgrade the relayfile daemon (>= control-plane API v3 with workspace identity) and re-run.`
    );
  }

  // Check-and-reserve happens INSIDE one journal update, under its exclusive
  // lock — two racing prepares cannot both observe "no matching attempt" and
  // both append their own reservation (check-then-write TOCTOU). The prior
  // binding is read (and its ids pre-recorded) only AFTER this lease is held,
  // making the lease the linearization point for the whole lifecycle.
  let conflict: 'live' | 'unreconciled' | undefined;
  await deps.cleanupJournal.update((entries) => {
    const retained = entries.filter(matchesAttemptKey);
    if (retained.length > 0) {
      conflict = retained.some((entry) => isOwnerLive(entry.owner)) ? 'live' : 'unreconciled';
      return entries;
    }
    const keys = new Set(entries.map(cleanupEntryKey));
    return keys.has(cleanupEntryKey(attempt)) ? entries : [...entries, attempt];
  });
  if (conflict === 'live') {
    throw new Error(
      `Another subscribe of ${attempt.provider} ${attempt.resource} appears to be in progress. Wait for it to finish (or for its process to exit) and re-run.`
    );
  }
  if (conflict === 'unreconciled') {
    if (!deps.relayfile.listWebhookSubscriptions) {
      throw new Error(
        `A previous subscribe of ${attempt.provider} ${attempt.resource} was interrupted before its relayfile webhook subscription could be recorded, and the installed @relayfile/client cannot list subscriptions to reconcile it. Aborting before creating another one (it would duplicate provider deliveries). Upgrade @relayfile/client to v3 and re-run.`
      );
    }
    throw new Error(
      `Could not reconcile the resources left by an interrupted subscribe of ${attempt.provider} ${attempt.resource}. Aborting before creating another subscription; re-run once relayfile-cloud is reachable.`
    );
  }
}

async function runSubscribe(
  deps: IntegrationCommandDependencies,
  providerArg: string | undefined,
  opts: Record<string, unknown>
): Promise<void> {
  await deps.relayfile.ensureCompatible();

  if (opts.list) {
    const local = await deps.resolveLocalRelayOptions();
    const relayOptions = sdkOptionsFromOpts(opts);
    const relay = deps.createAgentRelay(
      local && !explicitWorkspaceKey(opts) ? localRetryOptions(relayOptions, local) : relayOptions
    );
    const [bindings, webhooks, subscriptions] = await Promise.all([
      deps.relayfile.listBindings(),
      relay.webhooks.list(),
      relay.webhooks.subscriptions(),
    ]);
    printJson(deps, { bindings, webhooks, subscriptions });
    return;
  }

  const { provider, resource, to } = await promptSubscribeOptions(deps, providerArg, opts);
  const local = await deps.resolveLocalRelayOptions();
  await ensureProviderConnected(deps, provider, opts);

  // Canonicalize the user's native resource to the VFS glob relayfile keys the
  // binding under. relayfile stores (and `listBindings` returns) the resolved
  // glob, not the native spelling — so every subsequent match (findExistingBinding,
  // unbind, webhook identity) MUST be against the glob or it silently never hits.
  const resolved = await deps.relayfile.resolveResourcePath(provider, resource);
  const pathGlob = resolved.pathGlob;
  if (resolved.warning) {
    deps.error(`Warning: ${resolved.warning}`);
  }

  const relayOptions = sdkOptionsFromOpts(opts);
  const effectiveRelayOptions =
    local && !explicitWorkspaceKey(opts) ? localRetryOptions(relayOptions, local) : relayOptions;
  const relay = deps.createAgentRelay(effectiveRelayOptions);
  await ensureRecipient(relay, provider, to, opts);
  const channel = targetChannel(to);
  const events = commaList(opts.events);
  const writeback = await resolveWriteback(deps, opts, channel);
  const inboundTarget = await createRelayfileInboundTarget(opts, local, {
    channel,
    provider,
    pathGlob,
  });
  const prefix = webhookNamePrefix(provider, pathGlob);
  const name = inboundWebhookName(prefix);

  const relayScope = relayCleanupScope(effectiveRelayOptions);
  const relayfileScope = relayfileCleanupScope();
  // The attempt record is this transaction's lease AND its crash-recovery
  // anchor: written before any create, upgraded with each server-assigned id,
  // removed only on settle. Its deterministic keys — the inbound (url, glob
  // set) for the cloud subscription, the resource-scoped webhook name prefix,
  // and the per-channel writeback url — let a later run reconcile whichever
  // creates landed if this process dies at ANY point in between.
  const owner = newCleanupOwner();
  // The relay event subscription targets the per-channel writeback url with a
  // NONSECRET per-attempt marker appended. relayfile-cloud's writeback route
  // ignores the query string and its HMAC covers headers+body only, so
  // delivery is unaffected — but the exact url now uniquely identifies THIS
  // attempt's subscription, making post-create/pre-id crash recovery
  // deterministic with no cross-resource deletion risk on shared channels.
  const subscriptionTargetUrl = `${writeback.url}${writeback.url.includes('?') ? '&' : '?'}relaySubscribeAttempt=${owner.attemptId}`;
  const attempt: PendingCleanupEntry = {
    kind: 'subscribe-attempt',
    scope: relayfileScope,
    provider,
    resource: pathGlob,
    url: inboundTarget.url,
    pathGlobs: [pathGlob],
    webhookName: name,
    writebackUrl: subscriptionTargetUrl,
    relayScope,
    ...(writeback.workspaceId ? { relayfileWorkspaceId: writeback.workspaceId } : {}),
    owner,
  };
  const upgradeAttempt = async (patch: Partial<PendingCleanupEntry>): Promise<void> => {
    Object.assign(attempt, patch);
    // Best-effort: if the write fails, the previous attempt state (already
    // durable) still recovers this create through its deterministic key.
    await deps.cleanupJournal
      .update((entries) =>
        entries.map((entry) =>
          entry.owner?.attemptId === attempt.owner?.attemptId && entry.kind === 'subscribe-attempt'
            ? { ...entry, ...patch }
            : entry
        )
      )
      .catch(() =>
        deps.error(
          'Warning: could not update the subscribe attempt record; recovery falls back to its deterministic keys.'
        )
      );
  };
  await prepareSubscribeAttempt(deps, relay, attempt, channel, { relayScope, relayfileScope });
  // The reservation is durable — keep its lease fresh for as long as this
  // transaction runs, however long the external operations below take.
  const lease = startLeaseRenewal(deps, owner.attemptId);

  // With the lease held, capture the binding we're about to replace
  // (create-first: the per-attempt nonce in `name` means createInbound never
  // collides on the unique (workspace, name) index, so the replacement can
  // exist alongside the old one) and pre-record its non-rediscoverable ids
  // BEFORE any create/bind. A crash between the lease and this pre-record is
  // safe — nothing external has mutated; any failure here releases the lease
  // and aborts before mutations.
  let priorBinding: RelayfileBinding | undefined;
  try {
    priorBinding = await findExistingBinding(deps, provider, pathGlob);
    const priorEntries: PendingCleanupEntry[] = [];
    if (priorBinding?.subscriptionId) {
      priorEntries.push({ kind: 'relay-subscription', scope: relayScope, id: priorBinding.subscriptionId });
    }
    if (priorBinding?.webhookSubscriptionId) {
      priorEntries.push({
        kind: 'relayfile-webhook-subscription',
        scope: relayfileScope,
        id: priorBinding.webhookSubscriptionId,
        ...(priorBinding.webhookSubscriptionWorkspaceId
          ? { relayfileWorkspaceId: priorBinding.webhookSubscriptionWorkspaceId }
          : {}),
      });
    }
    if (priorEntries.length > 0) {
      await deps.cleanupJournal.update((entries) => {
        const keys = new Set(entries.map(cleanupEntryKey));
        return [...entries, ...priorEntries.filter((entry) => !keys.has(cleanupEntryKey(entry)))];
      });
    }
  } catch (err) {
    lease.stop();
    await removeCleanupEntry(deps, attempt).catch(() => undefined);
    throw err;
  }

  let webhook: { webhookId: string; token: string } | undefined;
  let subscription: { id: string } | undefined;
  let relayfileWebhook: RelayfileWebhookSubscription | undefined;
  let bindingInput: RelayfileBindingInput;
  try {
    lease.assertHealthy(`${provider} ${pathGlob}`);
    webhook = await relay.webhooks.createInbound({ channel, name });
    await upgradeAttempt({ webhookId: webhook.webhookId });
    lease.assertHealthy(`${provider} ${pathGlob}`);
    const createdRelayfileWebhook = await deps.relayfile.createWebhookSubscription({
      url: inboundTarget.url,
      pathGlobs: [pathGlob],
      secret: inboundTarget.secret,
      // Pin the create to the journaled workspace: an active-workspace switch
      // between writeback-secret resolution and this POST must not land the
      // subscription in a workspace other than the recorded pin.
      ...(attempt.relayfileWorkspaceId ? { workspace: attempt.relayfileWorkspaceId } : {}),
    });
    relayfileWebhook = createdRelayfileWebhook;
    if (
      attempt.relayfileWorkspaceId &&
      createdRelayfileWebhook.workspaceId &&
      createdRelayfileWebhook.workspaceId !== attempt.relayfileWorkspaceId
    ) {
      // The daemon created the subscription somewhere other than the pinned
      // workspace. Never overwrite the durable pin silently — fail into the
      // rollback (which deletes/records using the CREATE's actual echo).
      throw new Error(
        `relayfile created the webhook subscription in a different workspace than the one pinned for ${provider} ${pathGlob}; aborting and rolling back.`
      );
    }
    await upgradeAttempt({
      webhookSubscriptionId: createdRelayfileWebhook.subscriptionId,
      ...(createdRelayfileWebhook.workspaceId
        ? { relayfileWorkspaceId: createdRelayfileWebhook.workspaceId }
        : {}),
    });
    lease.assertHealthy(`${provider} ${pathGlob}`);
    subscription = await relay.integrations.subscriptions.create({
      event: events.length === 1 ? events[0]! : 'message.created',
      events: events.length ? events : ['message.created', 'thread.reply'],
      filter: { channel },
      url: subscriptionTargetUrl,
      secret: writeback.secret,
    });
    await upgradeAttempt({ subscriptionId: subscription.id });
    lease.assertHealthy(`${provider} ${pathGlob}`);
    bindingInput = {
      provider,
      resource: pathGlob,
      channel,
      webhookId: webhook.webhookId,
      webhookToken: webhook.token,
      subscriptionId: subscription.id,
      webhookSubscriptionId: createdRelayfileWebhook.subscriptionId,
      ...(attempt.relayfileWorkspaceId || createdRelayfileWebhook.workspaceId
        ? {
            webhookSubscriptionWorkspaceId:
              attempt.relayfileWorkspaceId ?? createdRelayfileWebhook.workspaceId,
          }
        : {}),
    };
    await deps.relayfile.bind(bindingInput);
  } catch (err) {
    // The new binding never fully landed: roll back only what we just created,
    // leave any prior working binding untouched, and keep/record a durable
    // entry for every id whose rollback delete fails. Successful deletes
    // resolve; anything unresolved keeps the attempt record as its anchor.
    let unresolved = false;
    if (subscription) {
      try {
        await relay.integrations.subscriptions.delete(subscription.id);
      } catch (cleanupErr) {
        if (!isNotFoundRelayError(cleanupErr)) {
          const recorded = await tryRecordCleanup(
            deps,
            { kind: 'relay-subscription', scope: relayScope, id: subscription.id },
            `${provider} ${pathGlob}`
          );
          unresolved ||= !recorded;
        }
      }
    }
    if (webhook) {
      try {
        await relay.webhooks.delete(webhook.webhookId);
      } catch (cleanupErr) {
        if (!isNotFoundRelayError(cleanupErr)) {
          const recorded = await tryRecordCleanup(
            deps,
            { kind: 'relay-webhook', scope: relayScope, id: webhook.webhookId },
            `${provider} ${pathGlob}`
          );
          unresolved ||= !recorded;
        }
      }
    }
    if (relayfileWebhook) {
      const rollbackWorkspaceId = relayfileWebhook.workspaceId ?? attempt.relayfileWorkspaceId;
      try {
        await deps.relayfile.deleteWebhookSubscription(relayfileWebhook.subscriptionId, rollbackWorkspaceId);
      } catch (cleanupErr) {
        if (!isAlreadyDeletedWebhookSubscription(cleanupErr) || !rollbackWorkspaceId) {
          const recorded = await tryRecordCleanup(
            deps,
            {
              kind: 'relayfile-webhook-subscription',
              scope: relayfileScope,
              id: relayfileWebhook.subscriptionId,
              ...(rollbackWorkspaceId ? { relayfileWorkspaceId: rollbackWorkspaceId } : {}),
            },
            `${provider} ${pathGlob}`
          );
          unresolved ||= !recorded;
        }
      }
    }
    lease.stop();
    if (!unresolved) {
      // Everything we created is deleted or durably recorded as an ownerless
      // entry — the attempt record has served its purpose. If it cannot be
      // removed it is only over-cautious: a later run reconciles it.
      await removeCleanupEntry(deps, attempt).catch(() => undefined);
    }
    throw err;
  }

  // New binding is live (relayfile.bind upserts on (provider, pathGlob)); its
  // record now persists all three ids, so the attempt record and the
  // pre-recorded prior-id entries it superseded are resolved. Then retire
  // what the binding replaced and sweep.
  lease.stop();
  await deps.cleanupJournal
    .update((entries) => {
      const resolved = new Set([cleanupEntryKey(attempt)]);
      return entries.filter((entry) => !resolved.has(cleanupEntryKey(entry)));
    })
    .catch(() =>
      deps.error(
        'Warning: could not clear the completed subscribe attempt record; a later run will reconcile it (guarded by the active binding).'
      )
    );
  await retireSupersededWebhooks(deps, relay, {
    provider,
    resource: pathGlob,
    prefix,
    keepWebhookId: webhook.webhookId,
    keepWebhookSubscriptionId: bindingInput.webhookSubscriptionId,
    priorBinding,
    relayScope,
    relayfileScope,
  });

  // Show the native resource the user typed, plus the resolved glob when they differ.
  const boundLabel = pathGlob === resource ? resource : `${resource} (${pathGlob})`;
  deps.log(`✓ ${provider} ${boundLabel} bound -> ${to}`);
  deps.log('✓ Server-side inbound webhook subscription created.');
  deps.log('✓ Listening. Replies will post back in-thread.');
}

async function runUnsubscribe(
  deps: IntegrationCommandDependencies,
  provider: string,
  opts: Record<string, unknown>
): Promise<void> {
  const resource = typeof opts.resource === 'string' ? opts.resource.trim() : '';
  if (!resource) {
    throw new Error('Missing --resource <value> for unsubscribe.');
  }
  await deps.relayfile.ensureCompatible();
  // Resolve native -> glob: relayfile keys bindings on the glob, so the user's
  // native `--resource` (e.g. owner/repo) must be canonicalized to match.
  const { pathGlob } = await deps.relayfile.resolveResourcePath(provider, resource);
  const local = await deps.resolveLocalRelayOptions();
  const relayOptions = sdkOptionsFromOpts(opts);
  const effectiveRelayOptions =
    local && !explicitWorkspaceKey(opts) ? localRetryOptions(relayOptions, local) : relayOptions;
  const relay = deps.createAgentRelay(effectiveRelayOptions);
  const relayScope = relayCleanupScope(effectiveRelayOptions);
  const relayfileScope = relayfileCleanupScope();

  // Retry recorded cleanup work before this run's own lifecycle mutations.
  await sweepPendingCleanups(deps, relay, { relayScope, relayfileScope });

  // Unsubscribe shares the per-(scope, provider, resource) lifecycle lease
  // with subscribe: without it, a stale unsubscribe could finish its deletes
  // AFTER a concurrent re-subscribe bound a fresh replacement and then
  // unbind() would discard that new binding, orphaning its resources.
  const reservation: PendingCleanupEntry = {
    kind: 'subscribe-attempt',
    operation: 'unsubscribe',
    scope: relayfileScope,
    provider,
    resource: pathGlob,
    owner: newCleanupOwner(),
  };
  let lifecycleConflict = false;
  await deps.cleanupJournal.update((entries) => {
    const conflicting = entries.some(
      (entry) =>
        entry.kind === 'subscribe-attempt' &&
        entry.scope === relayfileScope &&
        entry.provider === provider &&
        entry.resource === pathGlob &&
        isOwnerLive(entry.owner)
    );
    if (conflicting) {
      lifecycleConflict = true;
      return entries;
    }
    return [...entries, reservation];
  });
  if (lifecycleConflict) {
    throw new Error(
      `Another subscribe/unsubscribe of ${provider} ${resource} appears to be in progress. Wait for it to finish and re-run.`
    );
  }
  const unsubscribeLease = startLeaseRenewal(deps, reservation.owner!.attemptId);
  const releaseReservation = () => {
    unsubscribeLease.stop();
    return removeCleanupEntry(deps, reservation).catch(() => undefined);
  };

  // The binding is read only AFTER the lease is held — the lease is the
  // linearization point, so these ids cannot be a stale snapshot from before
  // a concurrent replacement completed.
  let binding: RelayfileBinding | undefined;
  try {
    const bindings = await deps.relayfile.listBindings();
    binding = bindings.find((item) => item.provider === provider && item.resource === pathGlob);
  } catch (err) {
    await releaseReservation();
    throw err;
  }
  if (!binding) {
    await releaseReservation();
    throw new Error(`No binding found for ${provider} ${resource}.`);
  }

  // The binding record about to be unbound holds the only persisted copy of
  // these ids. Any delete failure below must be durably journaled BEFORE
  // unbind, or the run aborts with the binding (and its ids) intact. The
  // whole post-reservation section always releases the lease — an abort that
  // left it live would wedge later lifecycles until this pid exits.
  try {
    const abortRetainingBinding = (what: string): never => {
      throw new Error(
        `Failed to remove the ${what} for ${provider} ${resource} and could not record it for retry. The binding was left in place — re-run \`integration unsubscribe\`.`
      );
    };

    const webhookSubId = binding.webhookSubscriptionId;
    if (webhookSubId) {
      unsubscribeLease.assertHealthy(`${provider} ${resource}`);
      const bindingWorkspaceId = binding.webhookSubscriptionWorkspaceId;
      const entry: PendingCleanupEntry = {
        kind: 'relayfile-webhook-subscription',
        scope: relayfileScope,
        id: webhookSubId,
        ...(bindingWorkspaceId ? { relayfileWorkspaceId: bindingWorkspaceId } : {}),
      };
      try {
        await deps.relayfile.deleteWebhookSubscription(webhookSubId, bindingWorkspaceId);
      } catch (err) {
        // A pinned 404 proves the subscription is gone. An UNPINNED 404 might
        // just be the wrong active workspace — record the id (retained until a
        // matching-workspace delete succeeds) before discarding the binding.
        if (!isAlreadyDeletedWebhookSubscription(err) || !bindingWorkspaceId) {
          const recorded = await tryRecordCleanup(deps, entry, `${provider} ${resource}`);
          if (!recorded) abortRetainingBinding('relayfile webhook subscription');
        }
      }
    }
    unsubscribeLease.assertHealthy(`${provider} ${resource}`);
    try {
      await relay.webhooks.delete(binding.webhookId);
    } catch (err) {
      if (!isNotFoundRelayError(err)) {
        const recorded = await tryRecordCleanup(
          deps,
          { kind: 'relay-webhook', scope: relayScope, id: binding.webhookId },
          `${provider} ${resource}`
        );
        if (!recorded) abortRetainingBinding('relay inbound webhook');
      }
    }
    unsubscribeLease.assertHealthy(`${provider} ${resource}`);
    try {
      await relay.webhooks.unsubscribe(binding.subscriptionId);
    } catch (err) {
      if (!isNotFoundRelayError(err)) {
        const recorded = await tryRecordCleanup(
          deps,
          { kind: 'relay-subscription', scope: relayScope, id: binding.subscriptionId },
          `${provider} ${resource}`
        );
        if (!recorded) abortRetainingBinding('relay event subscription');
      }
    }
    unsubscribeLease.assertHealthy(`${provider} ${resource}`);
    await deps.relayfile.unbind(provider, pathGlob);
  } finally {
    await releaseReservation();
  }
  deps.log(`Unsubscribed ${provider} ${resource}.`);
}

export function registerIntegrationCommands(
  program: Command,
  overrides: Partial<IntegrationCommandDependencies> = {}
): void {
  const deps = withIntegrationDefaults(overrides);
  const group = program.command('integration').description('Webhooks and event subscriptions');

  addSdkOptions(
    group
      .command('subscribe [provider]')
      .description('Subscribe a relay recipient to a relayfile integration')
      .option('--resource <value>', 'Provider-native resource (channel, project, label, etc.)')
      .option('--to <target>', 'Relay recipient, e.g. @agent or #channel')
      .option('--spawn <cli>', 'Register the recipient agent when it is absent')
      .option('--events <list>', 'Comma-separated relay event names', 'message.created,thread.reply')
      .option('--bridge-url <url>', 'Writeback bridge URL')
      .option('--bridge-secret <secret>', 'HMAC signing secret for the writeback bridge')
      .option('--list', 'List active relayfile integration bindings')
      .option('--no-input', 'Do not prompt or launch browser-based connect flows')
  ).action(async (provider: string | undefined, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runSubscribe(deps, provider, o);
    });
  });

  addSdkOptions(
    group
      .command('unsubscribe')
      .description('Remove a relayfile integration subscription')
      .argument('<provider>', 'Integration provider')
      .option('--resource <value>', 'Provider-native resource used when subscribing')
  ).action(async (provider: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runUnsubscribe(deps, provider, o);
    });
  });

  const webhook = group.command('webhook').description('Webhooks');

  addSdkOptions(
    webhook
      .command('create')
      .description('Register a webhook')
      .argument('<url>', 'Webhook URL')
      .option('--event <event>', 'Event to deliver')
  ).action(async (url: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) =>
          relay.integrations.webhooks.create({
            url,
            event: o.event as string | undefined,
          })
        )
      );
    });
  });

  addSdkOptions(webhook.command('list').description('List registered webhooks')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(
          deps,
          await runIntegrationOperation(deps, o, (relay) => relay.integrations.webhooks.list())
        );
      });
    }
  );

  addSdkOptions(
    webhook.command('delete').description('Delete a webhook').argument('<id>', 'Webhook id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runIntegrationOperation(deps, o, (relay) => relay.integrations.webhooks.delete(id));
      deps.log(`Deleted webhook ${id}.`);
    });
  });

  addSdkOptions(
    webhook
      .command('trigger')
      .description('Manually trigger a webhook')
      .argument('<id>', 'Webhook id')
      .option('--payload <json>', 'JSON payload', '{}')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const payload = JSON.parse((o.payload as string) ?? '{}') as Record<string, unknown>;
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) => relay.integrations.webhooks.trigger(id, payload))
      );
    });
  });

  // ── inbound webhooks (external services POST in → message into a channel) ──
  addSdkOptions(
    webhook
      .command('create-inbound')
      .description('Create an inbound webhook external services POST to, delivering messages into a channel')
      .argument('<channel>', 'Target channel the webhook posts into')
      .option('--name <name>', 'Human-readable webhook name (e.g. "GitHub Alerts")')
  ).action(async (channel: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) =>
          relay.webhooks.createInbound({
            channel,
            name: o.name as string | undefined,
          })
        )
      );
    });
  });

  addSdkOptions(webhook.command('list-inbound').description('List inbound webhooks')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(deps, await runIntegrationOperation(deps, o, (relay) => relay.webhooks.list()));
      });
    }
  );

  addSdkOptions(
    webhook
      .command('delete-inbound')
      .description('Delete an inbound webhook')
      .argument('<webhookId>', 'Inbound webhook id')
  ).action(async (webhookId: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runIntegrationOperation(deps, o, (relay) => relay.webhooks.delete(webhookId));
      deps.log(`Deleted inbound webhook ${webhookId}.`);
    });
  });

  const subscription = group.command('subscription').description('Event subscriptions');

  addSdkOptions(
    subscription
      .command('create')
      .description('Create a subscription to events')
      .argument('<event>', 'Event name')
      .option('--filter <filter>', 'Filter expression, e.g. channel=#ops')
      .option('--url <url>', 'Delivery URL for subscription')
      .option('--secret <secret>', 'HMAC signing secret')
  ).action(async (event: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      const filter = typeof o.filter === 'string' ? parseFilter(o.filter) : undefined;
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) =>
          relay.integrations.subscriptions.create({
            event,
            ...(filter ? { filter } : {}),
            ...(typeof o.url === 'string' ? { url: o.url } : {}),
            ...(typeof o.secret === 'string' ? { secret: o.secret } : {}),
          })
        )
      );
    });
  });

  addSdkOptions(subscription.command('list').description('List created subscriptions')).action(
    async (o: Record<string, unknown>) => {
      await runSdk(deps, async () => {
        printJson(
          deps,
          await runIntegrationOperation(deps, o, (relay) => relay.integrations.subscriptions.list())
        );
      });
    }
  );

  addSdkOptions(
    subscription.command('get').description('Get subscription details').argument('<id>', 'Subscription id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      printJson(
        deps,
        await runIntegrationOperation(deps, o, (relay) => relay.integrations.subscriptions.get(id))
      );
    });
  });

  addSdkOptions(
    subscription.command('delete').description('Delete a subscription').argument('<id>', 'Subscription id')
  ).action(async (id: string, o: Record<string, unknown>) => {
    await runSdk(deps, async () => {
      await runIntegrationOperation(deps, o, (relay) => relay.integrations.subscriptions.delete(id));
      deps.log(`Deleted subscription ${id}.`);
    });
  });
}
