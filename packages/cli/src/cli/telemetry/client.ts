/**
 * PostHog telemetry client singleton.
 */

import { PostHog } from 'posthog-node';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloudIdentityFingerprint,
  resolveCloudIdentity,
  type CloudIdentity,
} from '@agent-relay/cloud/identity';
import {
  isTelemetryEnabled,
  getDistinctId,
  getIdentifiedFingerprint,
  markIdentified,
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
 * — it belongs on the PostHog *person*, set once by {@link announceIdentity}.
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

/**
 * Announce the signed-in user (and their org) to PostHog.
 *
 * Two things happen the first time we see a given identity, and only then:
 *
 *  - `alias` folds the machine's anonymous distinct id into the user id, so the
 *    events emitted before login aren't stranded on a separate person. Without
 *    it, "how many users tried the CLI then signed up" is unanswerable.
 *  - `identify` / `groupIdentify` set person and group properties. Email lives
 *    here — as a person property — not on individual events.
 *
 * Repeated on org switch or email change (the fingerprint covers both), skipped
 * otherwise so we don't emit two extra events on every CLI invocation.
 */
function announceIdentity(posthog: PostHog, identity: CloudIdentity, machineDistinctId: string): void {
  const fingerprint = cloudIdentityFingerprint(identity);
  if (!fingerprint || fingerprint === getIdentifiedFingerprint()) return;

  try {
    if (machineDistinctId && machineDistinctId !== identity.userId) {
      posthog.alias({ distinctId: identity.userId, alias: machineDistinctId });
    }

    posthog.identify({
      distinctId: identity.userId,
      properties: {
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.organizationId ? { organization_id: identity.organizationId } : {}),
        ...(identity.organizationSlug ? { organization_slug: identity.organizationSlug } : {}),
        ...(identity.organizationName ? { organization_name: identity.organizationName } : {}),
        ...(identity.organizationRole ? { organization_role: identity.organizationRole } : {}),
        cloud_api_url: identity.apiUrl,
      },
    });

    if (identity.organizationId) {
      posthog.groupIdentify({
        groupType: ORGANIZATION_GROUP_TYPE,
        groupKey: identity.organizationId,
        properties: {
          ...(identity.organizationName ? { name: identity.organizationName } : {}),
          ...(identity.organizationSlug ? { slug: identity.organizationSlug } : {}),
        },
      });
    }

    markIdentified(fingerprint);
  } catch {
    // Telemetry must never break the CLI.
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

  console.log('');
  console.log('Agent Relay collects usage telemetry to improve the product.');
  console.log('Run `agent-relay telemetry disable` to opt out.');
  console.log('Learn more: https://agentrelay.com/telemetry');
  console.log('');

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
   * the identity env vars a parent process published, then falls back to the
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
  });

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

  const machineDistinctId = getDistinctId();
  // A signed-in user is the person; the machine hash is only a fallback.
  distinctId = identity?.userId ?? machineDistinctId;
  groups = identity?.organizationId ? { [ORGANIZATION_GROUP_TYPE]: identity.organizationId } : null;

  if (identity) {
    announceIdentity(client, identity, machineDistinctId);
  }

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

  client.capture({
    distinctId,
    event,
    properties: {
      ...commonProps,
      ...properties,
    },
    ...(groups ? { groups } : {}),
  });
}

export async function shutdown(): Promise<void> {
  if (!client) return;

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
    distinctId: identity?.userId ?? prefs.distinctId,
    notifiedAt: prefs.notifiedAt,
    ...(identity ? { userId: identity.userId } : {}),
    ...(identity?.email ? { email: identity.email } : {}),
    ...(identity?.organizationId ? { organizationId: identity.organizationId } : {}),
    ...(identity?.organizationSlug ? { organizationSlug: identity.organizationSlug } : {}),
  };
}
