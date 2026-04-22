/**
 * PostHog telemetry client singleton.
 */

import { PostHog } from 'posthog-node';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isTelemetryEnabled,
  getAnonymousId,
  wasNotified,
  markNotified,
  isDisabledByEnv,
  loadPrefs,
} from './config.js';
import type { CommonProperties, TelemetryEventName, TelemetryEventMap } from './events.js';
import { getPostHogConfig } from './posthog-config.js';

let client: PostHog | null = null;
let commonProps: CommonProperties | null = null;
let anonymousId: string | null = null;
let initialized = false;

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

function buildCommonProperties(versions: {
  cliVersion?: string;
  sdkVersion?: string;
  brokerVersion?: string;
}): CommonProperties {
  // The primary version depends on who's emitting: prefer CLI > broker > SDK
  // > fallback. This keeps `agent_relay_version` meaningful for existing
  // dashboards while the typed `cli_version`/`sdk_version`/`broker_version`
  // fields carry the precise per-component versions.
  const primary =
    versions.cliVersion ?? versions.brokerVersion ?? versions.sdkVersion ?? getFallbackVersion();

  return {
    agent_relay_version: primary,
    ...(versions.cliVersion ? { cli_version: versions.cliVersion } : {}),
    ...(versions.sdkVersion ? { sdk_version: versions.sdkVersion } : {}),
    ...(versions.brokerVersion ? { broker_version: versions.brokerVersion } : {}),
    os: process.platform,
    os_version: os.release(),
    node_version: process.version.slice(1),
    arch: process.arch,
  };
}

function showFirstRunNotice(): void {
  if (wasNotified()) return;

  if (isDisabledByEnv()) {
    markNotified();
    return;
  }

  console.log('');
  console.log('Agent Relay collects anonymous usage data to improve the product.');
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
}

export function initTelemetry(options: InitTelemetryOptions = {}): void {
  if (initialized) return;
  initialized = true;

  if (options.showNotice !== false) {
    showFirstRunNotice();
  }

  if (!isTelemetryEnabled()) return;

  const posthogConfig = getPostHogConfig();
  if (!posthogConfig) return;

  client = new PostHog(posthogConfig.apiKey, {
    host: posthogConfig.host,
    flushAt: 10,
    flushInterval: 10000,
    disableGeoip: false, // CLI runs on user's machine, so IP is correct for geo
  });

  commonProps = buildCommonProperties({
    cliVersion: options.cliVersion,
    sdkVersion: options.sdkVersion,
    brokerVersion: options.brokerVersion,
  });
  anonymousId = getAnonymousId();
}

export function track<E extends TelemetryEventName>(event: E, properties?: TelemetryEventMap[E]): void {
  if (!client || !commonProps || !anonymousId) return;

  client.capture({
    distinctId: anonymousId,
    event,
    properties: {
      ...commonProps,
      ...properties,
    },
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
    anonymousId = null;
    initialized = false;
  }
}

export function isEnabled(): boolean {
  return isTelemetryEnabled();
}

export { getAnonymousId };

export function getStatus(): {
  enabled: boolean;
  disabledByEnv: boolean;
  anonymousId: string;
  notifiedAt: string | undefined;
} {
  const prefs = loadPrefs();
  return {
    enabled: isTelemetryEnabled(),
    disabledByEnv: isDisabledByEnv(),
    anonymousId: prefs.anonymousId,
    notifiedAt: prefs.notifiedAt,
  };
}
