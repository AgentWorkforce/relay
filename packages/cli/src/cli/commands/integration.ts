import type { Command } from 'commander';
import { createHash, randomBytes } from 'node:crypto';
import { getProjectPaths } from '@agent-relay/config';
import type { AgentRelayAgent } from '@agent-relay/sdk';

import {
  cleanupEntryKey,
  fileCleanupJournal,
  type CleanupJournal,
  type PendingCleanupEntry,
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
}

export interface RelayfileWebhookSubscription {
  subscriptionId: string;
  secret?: string;
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
  }): Promise<RelayfileWebhookSubscription>;
  deleteWebhookSubscription(subscriptionId: string): Promise<void>;
  /**
   * Lists the workspace's inbound webhook subscriptions so crash-recovery can
   * find subscriptions whose server-assigned id was never persisted. Optional:
   * the published @relayfile/client v0.10.20 does not ship it, so the default
   * bridge exposes it only when the installed client does (see
   * defaultRelayfileBridge). Absent list capability, recovery falls back to
   * retaining intent records and refusing same-key re-subscribes.
   */
  listWebhookSubscriptions?: () => Promise<
    Array<{ subscriptionId: string; url: string; pathGlobs: string[] }>
  >;
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
        const { webhookSubscriptionId } = b as typeof b & { webhookSubscriptionId?: string };
        return {
          provider: b.provider ?? '',
          resource: b.pathGlob ?? '',
          channel: b.channel ?? '',
          webhookId: b.webhookId ?? '',
          subscriptionId: b.subscriptionId ?? '',
          webhookSubscriptionId,
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
        const { url, secret } = await client.writebackSecret(channel);
        if (!url?.trim() || !secret?.trim()) return undefined;
        return { url: url.trim(), secret: secret.trim() };
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
      return client.createWebhookSubscription(input);
    },
    async deleteWebhookSubscription(subscriptionId) {
      await client.deleteWebhookSubscription(subscriptionId);
    },
    // TEMPORARY runtime feature-detection: published @relayfile/client v0.10.20
    // has no listWebhookSubscriptions (a cast cannot conjure a missing runtime
    // method). Expose it only when the installed client ships it; collapse to
    // a plain method once the v3 client (relayfile#346) is published and pinned.
    ...(typeof (client as { listWebhookSubscriptions?: unknown }).listWebhookSubscriptions === 'function'
      ? {
          listWebhookSubscriptions: async () => {
            const result = await (
              client as unknown as {
                listWebhookSubscriptions: () => Promise<{
                  subscriptions?: Array<{
                    subscriptionId?: string;
                    url?: string;
                    pathGlobs?: string[];
                  }>;
                }>;
              }
            ).listWebhookSubscriptions();
            return (result.subscriptions ?? []).map((s) => ({
              subscriptionId: s.subscriptionId ?? '',
              url: s.url ?? '',
              pathGlobs: s.pathGlobs ?? [],
            }));
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
): Promise<{ url: string; secret: string }> {
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
  return { url: binding.url, secret: binding.secret };
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

/** Non-secret identity of the relay connection a journal entry may retry through. */
function relayCleanupScope(options: SdkClientOptions): string {
  let workspaceKey = '';
  try {
    workspaceKey = resolveWorkspaceKey(options);
  } catch {
    // No resolvable key: scope on the base URL alone. Entries recorded this
    // way still never leak the key (only a digest is stored).
  }
  const digest = createHash('sha256')
    .update(`${resolveBaseUrl(options) ?? ''}|${workspaceKey}`)
    .digest('hex')
    .slice(0, 16);
  return `relay:${digest}`;
}

/** The default bridge always talks to the project-local relayfile daemon, so
 * the project data dir holding the journal IS the connection identity. */
function relayfileCleanupScope(): string {
  return 'relayfile:project-daemon';
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
    case 'relayfile-webhook-subscription-intent':
      return 'relayfile webhook subscription';
    case 'relay-webhook':
      return 'relay inbound webhook';
    case 'relay-subscription':
      return 'relay event subscription';
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
 * each subscribe/unsubscribe. Guards: entries from other scopes are untouched;
 * ids referenced by an active binding or the caller's keep-set are never
 * deleted; intent recovery needs the (optional) list capability and excludes
 * the same active/keep ids. Failures keep the entry (idempotent delete-404 in
 * relayfile#346 makes retries converge). Never logs entry urls or ids.
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

  for (const entry of entries) {
    try {
      switch (entry.kind) {
        case 'relayfile-webhook-subscription': {
          if (entry.scope !== options.relayfileScope || !entry.id) continue;
          if (activeWebhookSubscriptionIds.has(entry.id)) continue;
          try {
            await deps.relayfile.deleteWebhookSubscription(entry.id);
          } catch (err) {
            if (!isAlreadyDeletedWebhookSubscription(err)) throw err;
          }
          await removeCleanupEntry(deps, entry);
          deps.log('Retired a relayfile webhook subscription from an earlier failed cleanup.');
          break;
        }
        case 'relayfile-webhook-subscription-intent': {
          if (entry.scope !== options.relayfileScope) continue;
          const listSubscriptions = deps.relayfile.listWebhookSubscriptions;
          if (!listSubscriptions) continue; // recover once the v3 client is pinned
          const subscriptions = await listSubscriptions();
          const orphans = subscriptions.filter(
            (subscription) =>
              subscription.url === entry.url &&
              sameGlobSet(subscription.pathGlobs, entry.pathGlobs) &&
              !activeWebhookSubscriptionIds.has(subscription.subscriptionId)
          );
          for (const orphan of orphans) {
            try {
              await deps.relayfile.deleteWebhookSubscription(orphan.subscriptionId);
            } catch (err) {
              if (!isAlreadyDeletedWebhookSubscription(err)) throw err;
            }
          }
          await removeCleanupEntry(deps, entry);
          deps.log(
            `Reconciled ${orphans.length} relayfile webhook subscription(s) left by an interrupted subscribe of ${entry.provider ?? 'unknown'} ${entry.resource ?? ''}.`
          );
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
    const entry: PendingCleanupEntry = {
      kind: 'relayfile-webhook-subscription',
      scope: options.relayfileScope,
      id: priorWebhookSubId,
    };
    try {
      await deps.relayfile.deleteWebhookSubscription(priorWebhookSubId);
      await removeCleanupEntry(deps, entry).catch(() => undefined);
    } catch (err) {
      if (isAlreadyDeletedWebhookSubscription(err)) {
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

  const legacyName = `relayfile:${provider}`;
  for (const hook of webhooks) {
    // Never delete a webhook an active binding references — that includes the
    // one we just bound, and guards against a concurrent re-subscribe that
    // upserted a newer same-prefix binding between our bind and this sweep.
    if (hook.webhookId === keepWebhookId || activeWebhookIds.has(hook.webhookId)) continue;
    const isPrior = priorBinding?.webhookId === hook.webhookId;
    const isSameResourceOrphan = hook.name?.startsWith(`${prefix}:`) ?? false;
    const isUnboundLegacy = hook.name === legacyName;
    if (!isPrior && !isSameResourceOrphan && !isUnboundLegacy) continue;
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
 * 2. A retained intent with the same (scope, provider, resource, url, glob
 *    set) after the sweep means an earlier subscribe may have created a cloud
 *    subscription whose id was never persisted and it could not be
 *    reconciled — without list capability (published v0.10.20 client), or with
 *    it but unreachable. Abort: creating another subscription would double
 *    provider deliveries.
 * 3. Journal, in ONE atomic write, the new intent AND the prior binding's
 *    non-rediscoverable ids — bind() is about to overwrite their only other
 *    persisted home. Until then the sweep's active-binding guard keeps the
 *    pre-recorded ids untouchable. Any journal failure aborts the run
 *    (nothing external has been created yet).
 */
async function prepareSubscribeIntent(
  deps: IntegrationCommandDependencies,
  relay: AgentRelayAgent,
  intent: PendingCleanupEntry,
  priorBinding: RelayfileBinding | undefined,
  scopes: { relayScope: string; relayfileScope: string }
): Promise<void> {
  const hasRetainedIntent = (entries: PendingCleanupEntry[]): boolean =>
    entries.some(
      (entry) =>
        entry.kind === 'relayfile-webhook-subscription-intent' &&
        entry.scope === intent.scope &&
        entry.provider === intent.provider &&
        entry.resource === intent.resource &&
        entry.url === intent.url &&
        sameGlobSet(entry.pathGlobs, intent.pathGlobs)
    );

  await sweepPendingCleanups(deps, relay, scopes);
  if (hasRetainedIntent(await deps.cleanupJournal.list())) {
    if (!deps.relayfile.listWebhookSubscriptions) {
      throw new Error(
        `A previous subscribe of ${intent.provider} ${intent.resource} was interrupted before its relayfile webhook subscription could be recorded, and the installed @relayfile/client cannot list subscriptions to reconcile it. Aborting before creating another one (it would duplicate provider deliveries). Upgrade @relayfile/client to v3 and re-run.`
      );
    }
    throw new Error(
      `Could not reconcile the relayfile webhook subscription left by an interrupted subscribe of ${intent.provider} ${intent.resource}. Aborting before creating another one; re-run once relayfile-cloud is reachable.`
    );
  }

  const preRecorded: PendingCleanupEntry[] = [intent];
  if (priorBinding?.subscriptionId) {
    preRecorded.push({
      kind: 'relay-subscription',
      scope: scopes.relayScope,
      id: priorBinding.subscriptionId,
    });
  }
  if (priorBinding?.webhookSubscriptionId) {
    preRecorded.push({
      kind: 'relayfile-webhook-subscription',
      scope: scopes.relayfileScope,
      id: priorBinding.webhookSubscriptionId,
    });
  }
  await deps.cleanupJournal.update((entries) => {
    const keys = new Set(entries.map(cleanupEntryKey));
    return [...entries, ...preRecorded.filter((entry) => !keys.has(cleanupEntryKey(entry)))];
  });
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

  // Capture the binding we're about to replace *before* touching anything, so we
  // can retire it only after the new one is fully live (create-first). A
  // per-attempt nonce in `name` means createInbound never collides on the unique
  // (workspace, name) index, so the replacement can exist alongside the old one.
  const priorBinding = await findExistingBinding(deps, provider, pathGlob);

  // The cloud create returns a server-assigned id, so a crash between the
  // create and persisting that id would otherwise orphan the subscription.
  // Journal the intent — keyed by the deterministic (url, glob set) recovery
  // key — BEFORE any external create; a journal failure aborts the whole run.
  const relayScope = relayCleanupScope(effectiveRelayOptions);
  const relayfileScope = relayfileCleanupScope();
  const intent: PendingCleanupEntry = {
    kind: 'relayfile-webhook-subscription-intent',
    scope: relayfileScope,
    provider,
    resource: pathGlob,
    url: inboundTarget.url,
    pathGlobs: [pathGlob],
  };
  await prepareSubscribeIntent(deps, relay, intent, priorBinding, { relayScope, relayfileScope });

  let webhook: { webhookId: string; token: string } | undefined;
  let subscription: { id: string } | undefined;
  let relayfileWebhook: RelayfileWebhookSubscription | undefined;
  let subscriptionRecorded = false;
  let bindingInput: RelayfileBindingInput;
  try {
    webhook = await relay.webhooks.createInbound({ channel, name });
    const createdRelayfileWebhook = await deps.relayfile.createWebhookSubscription({
      url: inboundTarget.url,
      pathGlobs: [pathGlob],
      secret: inboundTarget.secret,
    });
    relayfileWebhook = createdRelayfileWebhook;
    // Upgrade the intent to the concrete server-assigned id. Best-effort: if
    // the write fails the retained intent stays the durable record for this
    // create (list-based recovery), so the run may continue.
    await deps.cleanupJournal
      .update((entries) => {
        const withoutIntent = entries.filter((entry) => cleanupEntryKey(entry) !== cleanupEntryKey(intent));
        const concrete: PendingCleanupEntry = {
          kind: 'relayfile-webhook-subscription',
          scope: relayfileScope,
          id: createdRelayfileWebhook.subscriptionId,
        };
        return withoutIntent.some((entry) => cleanupEntryKey(entry) === cleanupEntryKey(concrete))
          ? withoutIntent
          : [...withoutIntent, concrete];
      })
      .catch(() =>
        deps.error(
          'Warning: could not upgrade the recorded subscribe intent to its created subscription; the retained intent still covers recovery.'
        )
      );
    subscription = await relay.integrations.subscriptions.create({
      event: events.length === 1 ? events[0]! : 'message.created',
      events: events.length ? events : ['message.created', 'thread.reply'],
      filter: { channel },
      url: writeback.url,
      secret: writeback.secret,
    });
    // The relay event subscription is not re-discoverable after a crash, so
    // it must be durably recorded BEFORE bind. A journal failure here aborts
    // into the rollback below while the id is still in memory — nothing is
    // silently lost.
    await deps.cleanupJournal.update((entries) => {
      const entry: PendingCleanupEntry = {
        kind: 'relay-subscription',
        scope: relayScope,
        id: subscription!.id,
      };
      return entries.some((existing) => cleanupEntryKey(existing) === cleanupEntryKey(entry))
        ? entries
        : [...entries, entry];
    });
    subscriptionRecorded = true;
    bindingInput = {
      provider,
      resource: pathGlob,
      channel,
      webhookId: webhook.webhookId,
      webhookToken: webhook.token,
      subscriptionId: subscription.id,
      webhookSubscriptionId: createdRelayfileWebhook.subscriptionId,
    };
    await deps.relayfile.bind(bindingInput);
  } catch (err) {
    // The new binding never fully landed: roll back only what we just created,
    // leave any prior working binding untouched, and keep/record a journal
    // entry for every id whose rollback delete fails — none of them has
    // another durable home. Successful deletes clear their entries.
    if (subscription) {
      const entry: PendingCleanupEntry = {
        kind: 'relay-subscription',
        scope: relayScope,
        id: subscription.id,
      };
      try {
        await relay.integrations.subscriptions.delete(subscription.id);
        await removeCleanupEntry(deps, entry).catch(() => undefined);
      } catch (cleanupErr) {
        if (isNotFoundRelayError(cleanupErr)) {
          await removeCleanupEntry(deps, entry).catch(() => undefined);
        } else if (!subscriptionRecorded) {
          await tryRecordCleanup(deps, entry, `${provider} ${pathGlob}`);
        } else {
          deps.error(
            `Warning: could not roll back the relay event subscription for ${provider} ${pathGlob}; it stays recorded for a later run.`
          );
        }
      }
    }
    if (webhook) {
      const webhookId = webhook.webhookId;
      try {
        await relay.webhooks.delete(webhookId);
      } catch (cleanupErr) {
        if (!isNotFoundRelayError(cleanupErr)) {
          await tryRecordCleanup(
            deps,
            { kind: 'relay-webhook', scope: relayScope, id: webhookId },
            `${provider} ${pathGlob}`
          );
        }
      }
    }
    if (relayfileWebhook) {
      const entry: PendingCleanupEntry = {
        kind: 'relayfile-webhook-subscription',
        scope: relayfileScope,
        id: relayfileWebhook.subscriptionId,
      };
      try {
        await deps.relayfile.deleteWebhookSubscription(relayfileWebhook.subscriptionId);
        // Cloud state settled: clear both the concrete entry and (if the
        // upgrade write failed) the retained intent.
        await removeCleanupEntry(deps, entry).catch(() => undefined);
        await removeCleanupEntry(deps, intent).catch(() => undefined);
      } catch (cleanupErr) {
        if (isAlreadyDeletedWebhookSubscription(cleanupErr)) {
          await removeCleanupEntry(deps, entry).catch(() => undefined);
          await removeCleanupEntry(deps, intent).catch(() => undefined);
        } else {
          // Keep whichever durable record exists (concrete entry and/or
          // intent); if neither write ever landed the journal itself is
          // broken and the next subscribe fails closed on it.
          await tryRecordCleanup(deps, entry, `${provider} ${pathGlob}`);
        }
      }
    } else {
      // The cloud create never happened — the intent has served its purpose.
      await removeCleanupEntry(deps, intent).catch(() => undefined);
    }
    throw err;
  }

  // New binding is live (relayfile.bind upserts on (provider, pathGlob)); its
  // record now persists both the cloud subscription id and the relay event
  // subscription id, so the pre-recorded entries for them (and the intent)
  // are resolved. Then retire what the binding superseded and sweep.
  await deps.cleanupJournal
    .update((entries) => {
      const resolved = new Set(
        [
          intent,
          {
            kind: 'relayfile-webhook-subscription' as const,
            scope: relayfileScope,
            id: bindingInput.webhookSubscriptionId,
          },
          { kind: 'relay-subscription' as const, scope: relayScope, id: bindingInput.subscriptionId },
        ].map(cleanupEntryKey)
      );
      return entries.filter((entry) => !resolved.has(cleanupEntryKey(entry)));
    })
    .catch(() =>
      deps.error(
        'Warning: could not clear resolved cleanup records; a later run will reconcile them (guarded by the active binding).'
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
  const bindings = await deps.relayfile.listBindings();
  const binding = bindings.find((item) => item.provider === provider && item.resource === pathGlob);
  if (!binding) {
    throw new Error(`No binding found for ${provider} ${resource}.`);
  }
  const local = await deps.resolveLocalRelayOptions();
  const relayOptions = sdkOptionsFromOpts(opts);
  const effectiveRelayOptions =
    local && !explicitWorkspaceKey(opts) ? localRetryOptions(relayOptions, local) : relayOptions;
  const relay = deps.createAgentRelay(effectiveRelayOptions);
  const relayScope = relayCleanupScope(effectiveRelayOptions);
  const relayfileScope = relayfileCleanupScope();

  // Retry recorded cleanup work before this run's own lifecycle mutations.
  await sweepPendingCleanups(deps, relay, { relayScope, relayfileScope });

  // The binding record about to be unbound holds the only persisted copy of
  // these ids. Any delete failure below must be durably journaled BEFORE
  // unbind, or the run aborts with the binding (and its ids) intact.
  const abortRetainingBinding = (what: string): never => {
    throw new Error(
      `Failed to remove the ${what} for ${provider} ${resource} and could not record it for retry. The binding was left in place — re-run \`integration unsubscribe\`.`
    );
  };

  const webhookSubId = binding.webhookSubscriptionId;
  if (webhookSubId) {
    try {
      await deps.relayfile.deleteWebhookSubscription(webhookSubId);
    } catch (err) {
      if (!isAlreadyDeletedWebhookSubscription(err)) {
        const recorded = await tryRecordCleanup(
          deps,
          { kind: 'relayfile-webhook-subscription', scope: relayfileScope, id: webhookSubId },
          `${provider} ${resource}`
        );
        if (!recorded) abortRetainingBinding('relayfile webhook subscription');
      }
    }
  }
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
  await deps.relayfile.unbind(provider, pathGlob);
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
