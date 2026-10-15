/**
 * PostHog telemetry client singleton.
 */

import { PostHog } from 'posthog-node';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishCloudIdentity, resolveCloudIdentity, type CloudIdentity } from '@agent-relay/cloud/identity';
import {
  isTelemetryEnabled,
  getDistinctId,
  syncAuthGeneration,
  wasNotified,
  markNotified,
  isDisabledByEnv,
  loadPrefs,
} from './config.js';
import type { CommonProperties, TelemetryEventName, TelemetryEventMap } from './events.js';
import { createDistinctId } from './machine-id.js';
import { getPostHogConfig } from './posthog-config.js';
import { detectOrchestratorHarness, UNKNOWN_ORCHESTRATOR_HARNESS } from './orchestrator-harness.js';

/** PostHog group type for cloud organizations. Keep in sync with the gateway. */
export const ORGANIZATION_GROUP_TYPE = 'organization';

/** Env var carrying the hashed machine id to child processes. */
export const MACHINE_ID_ENV = 'AGENT_RELAY_MACHINE_ID';

let client: PostHog | null = null;
let commonProps: CommonProperties | null = null;
let distinctId: string | null = null;
let groups: Record<string, string> | null = null;
let initialized = false;
let firstRunDetected = false;
let identityOverride: CloudIdentity | null | undefined;

function findPackageJson(startDir: string): string | null {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Fallback version reader — walks up from the telemetry package's own
 * `__dirname`. In an installed layout this resolves to the telemetry
 * package's `package.json`, which is NOT meaningful to the product.
 * Prefer having the caller pass explicit versions via `initTelemetry()`.
 */
function getFallbackVersion(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const packageJsonPath = findPackageJson(__dirname);
    if (packageJsonPath) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      return pkg.version || 'unknown';
    }
  } catch {
    // Fall through
  }
  return 'unknown';
}

function buildCommonProperties(
  versions: {
    cliVersion?: string;
    sdkVersion?: string;
    brokerVersion?: string;
    app?: string;
    surface?: string;
    orchestratorHarness?: string;
  },
  identity: CloudIdentity | null
): CommonProperties {
  // The primary version depends on who's emitting: prefer CLI > broker > SDK
  // > fallback. This keeps `agent_relay_version` meaningful for existing
  // dashboards while the typed `cli_version`/`sdk_version`/`broker_version`
  // fields carry the precise per-component versions.
  const primary =
    versions.cliVersion ?? versions.brokerVersion ?? versions.sdkVersion ?? getFallbackVersion();

  return {
    app:
      versions.app ??
      (versions.cliVersion
        ? 'cli'
        : versions.brokerVersion
          ? 'broker'
          : versions.sdkVersion
            ? 'sdk'
            : 'unknown'),
    surface:
      versions.surface ??
      (versions.cliVersion
        ? 'cli'
        : versions.brokerVersion
          ? 'broker'
          : versions.sdkVersion
            ? 'sdk'
            : 'unknown'),
    orchestrator_harness:
      versions.orchestratorHarness ?? detectOrchestratorHarness() ?? UNKNOWN_ORCHESTRATOR_HARNESS,
    agent_relay_version: primary,
    ...(versions.cliVersion ? { cli_version: versions.cliVersion } : {}),
    ...(versions.sdkVersion ? { sdk_version: versions.sdkVersion } : {}),
    ...(versions.brokerVersion ? { broker_version: versions.brokerVersion } : {}),
    os: process.platform,
    os_version: os.release(),
    node_version: process.version.slice(1),
    arch: process.arch,
    ...identityProperties(identity),
  };
}

/**
 * Identity dimensions attached to every event. The email is deliberately absent
 * — Cloud owns authoritative PostHog person properties.
 *
 * `machine_id` is emitted whether or not anyone is signed in: the distinct id
 * becomes the user id after login, so the machine dimension only survives as its
 * own property. That is what makes machines-per-account and accounts-per-machine
 * answerable.
 */
function identityProperties(identity: CloudIdentity | null): Partial<CommonProperties> {
  const machineId = safeMachineId();
  const base = machineId ? { machine_id: machineId } : {};

  if (!identity) return { ...base, is_authenticated: false };

  return {
    ...base,
    is_authenticated: true,
    user_id: identity.userId,
    ...(identity.organizationId ? { organization_id: identity.organizationId } : {}),
    ...(identity.organizationSlug ? { organization_slug: identity.organizationSlug } : {}),
    ...(identity.workspaceId ? { cloud_workspace_id: identity.workspaceId } : {}),
  };
}

/**
 * The hashed machine id, preferring a value a parent process already published
 * so every process in one CLI invocation reports the same machine.
 */
function safeMachineId(): string | undefined {
  try {
    return process.env[MACHINE_ID_ENV]?.trim() || createDistinctId();
  } catch {
    return undefined;
  }
}

/** Identity resolution touches the filesystem — never let it break telemetry. */
function safeResolveCloudIdentity(): CloudIdentity | null {
  try {
    return resolveCloudIdentity();
  } catch {
    return null;
  }
}

function showFirstRunNotice(): void {
  if (wasNotified()) return;

  firstRunDetected = true;

  if (isDisabledByEnv()) {
    markNotified();
    return;
  }

  // Notices are diagnostics, never command data. Keeping them on stderr means
  // a first run cannot corrupt commands whose stdout is a JSON contract.
  console.error('');
  console.error('Agent Relay collects usage telemetry to improve the product.');
  console.error('Run `agent-relay telemetry disable` to opt out.');
  console.error('Learn more: https://agentrelay.com/telemetry');
  console.error('');

  markNotified();
}

export interface InitTelemetryOptions {
  /** Whether to show the first-run telemetry notice. Default: true. */
  showNotice?: boolean;
  /**
   * The emitter's own CLI version, e.g. the root `agent-relay` package version.
   * Pass this explicitly — the fallback auto-detection resolves the *telemetry*
   * package's `package.json`, not the product's.
   */
  cliVersion?: string;
  /** Resolved `@agent-relay/sdk` version, if known. */
  sdkVersion?: string;
  /** `agent-relay-broker` Rust binary version, if known. */
  brokerVersion?: string;
  /** Component emitting telemetry, e.g. `cli`, `broker`, or `sdk`. */
  app?: string;
  /** Product surface responsible for telemetry, e.g. `cli`, `cloud`, or `sdk`. */
  surface?: string;
  /** Parent harness driving Agent Relay, if already detected by the caller. */
  orchestratorHarness?: string;
  /**
   * Signed-in cloud identity. Defaults to `resolveCloudIdentity()`, which reads
   * the current
   * on-disk identity written at `agent-relay cloud login`. Pass `null` to force
   * anonymous attribution.
   */
  identity?: CloudIdentity | null;
}

export function initTelemetry(options: InitTelemetryOptions = {}): void {
  if (initialized) return;
  initialized = true;

  const posthogConfig = getPostHogConfig();
  if (!posthogConfig) return;

  if (options.showNotice !== false) {
    showFirstRunNotice();
  }
  if (!isTelemetryEnabled()) {
    firstRunDetected = false;
    return;
  }

  client = new PostHog(posthogConfig.apiKey, {
    host: posthogConfig.host,
    flushAt: 10,
    flushInterval: 10000,
    disableGeoip: false, // CLI runs on user's machine, so IP is correct for geo
    fetch: async (url, init) => {
      // Recheck at send time: opting out in another process must also discard
      // already queued batches that have not crossed the transport boundary.
      if (!isTelemetryEnabled()) return new Response('{}', { status: 200 });
      return fetch(url, init);
    },
  });

  identityOverride = options.identity;
  const identity = options.identity === undefined ? safeResolveCloudIdentity() : options.identity;

  commonProps = buildCommonProperties(
    {
      cliVersion: options.cliVersion,
      sdkVersion: options.sdkVersion,
      brokerVersion: options.brokerVersion,
      app: options.app,
      surface: options.surface,
      orchestratorHarness: options.orchestratorHarness,
    },
    identity
  );

  syncAuthGeneration(identity?.userId);
  distinctId = identity?.userId ?? getDistinctId();
  groups = identityGroups(identity);

  if (firstRunDetected) {
    track('cli_install', {
      version: commonProps.cli_version ?? commonProps.agent_relay_version,
      success: true,
    });
    firstRunDetected = false;
  }
}

export function track<E extends TelemetryEventName>(
  event: E,
  properties?: TelemetryEventMap[E] & Partial<CommonProperties>
): void {
  if (!client || !commonProps || !distinctId) return;
  if (!isTelemetryEnabled()) {
    clearPendingEvents();
    publishCloudIdentity(null);
    return;
  }
  // Files may change while an MCP/CLI process stays alive. Reconcile before
  // capture, never rely on the identity cached at process bootstrap.
  const identity = identityOverride === undefined ? safeResolveCloudIdentity() : identityOverride;
  const anonymousId = syncAuthGeneration(identity?.userId);
  distinctId = identity?.userId ?? anonymousId;
  groups = identityGroups(identity);
  publishCloudIdentity(identity);
  if (!identity) process.env.AGENT_RELAY_DISTINCT_ID = anonymousId;
  const {
    user_id: _user,
    organization_id: _org,
    organization_slug: _slug,
    cloud_workspace_id: _workspace,
    ...base
  } = commonProps;
  commonProps = { ...base, ...identityProperties(identity) };

  client.capture({
    distinctId,
    event,
    properties: {
      ...commonProps,
      ...properties,
      ...identityProperties(identity),
      analytics_contract_version: 2,
      emitter: `relay-${commonProps.app}`,
      identity_source: identity ? 'cloud_session' : 'anonymous_generation',
      actor_kind: process.env.AGENT_RELAY_ORIGIN_ACTOR?.includes('/agent/') ? 'agent' : 'human',
      ...(process.env.AGENT_RELAY_ORIGIN_ACTOR?.includes('/agent/')
        ? {
            actor_id: process.env.AGENT_RELAY_ORIGIN_ACTOR,
            ...(identity ? { owner_user_id: identity.userId } : {}),
          }
        : {}),
      $process_person_profile: Boolean(identity),
    },
    ...(groups ? { groups } : {}),
  });
}

function identityGroups(identity: CloudIdentity | null): Record<string, string> | null {
  if (!identity) return null;
  return {
    ...(identity.organizationId ? { organization: identity.organizationId } : {}),
    ...(identity.workspaceId ? { workspace: identity.workspaceId } : {}),
  };
}

function clearPendingEvents(): void {
  if (!client) return;
  // Public persistence API of the pinned PostHog SDK. optOut alone leaves the
  // queue intact and shutdown would otherwise deliver pre-opt-out events.
  client.setPersistedProperty('queue' as Parameters<PostHog['setPersistedProperty']>[0], []);
}

export async function shutdown(): Promise<void> {
  if (!client) {
    initialized = false;
    return;
  }
  if (!isTelemetryEnabled()) clearPendingEvents();

  try {
    await client.shutdown();
  } catch {
    // Ignore
  } finally {
    client = null;
    commonProps = null;
    distinctId = null;
    groups = null;
    initialized = false;
    identityOverride = undefined;
  }
}

export function isEnabled(): boolean {
  return isTelemetryEnabled();
}

export { getDistinctId };

export function getStatus(): {
  enabled: boolean;
  disabledByEnv: boolean;
  distinctId: string;
  notifiedAt: string | undefined;
  userId?: string;
  email?: string;
  organizationId?: string;
  organizationSlug?: string;
} {
  const prefs = loadPrefs();
  const identity = safeResolveCloudIdentity();
  return {
    enabled: isTelemetryEnabled(),
    disabledByEnv: isDisabledByEnv(),
    // Report the id events will actually carry, not just the machine hash.
    distinctId: identity?.userId ?? getDistinctId(),
    notifiedAt: prefs.notifiedAt,
    ...(identity ? { userId: identity.userId } : {}),
    ...(identity?.email ? { email: identity.email } : {}),
    ...(identity?.organizationId ? { organizationId: identity.organizationId } : {}),
    ...(identity?.organizationSlug ? { organizationSlug: identity.organizationSlug } : {}),
  };
}
