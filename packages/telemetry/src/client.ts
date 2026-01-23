/**
 * PostHog telemetry client.
 * Singleton pattern - initialized once, used throughout the application.
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
import type {
  CommonProperties,
  TelemetryEventName,
  TelemetryEventMap,
} from './events.js';
import { getPostHogConfig } from './posthog-config.js';

let client: PostHog | null = null;
let commonProps: CommonProperties | null = null;
let anonymousId: string | null = null;
let initialized = false;

/**
 * Find package.json by walking up from the given directory.
 */
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
 * Get the Agent Relay version from package.json.
 */
function getVersion(): string {
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

/**
 * Build common properties that are attached to every event.
 */
function buildCommonProperties(): CommonProperties {
  return {
    agent_relay_version: getVersion(),
    os: process.platform,
    os_version: os.release(),
    node_version: process.version.slice(1), // Remove 'v' prefix
    arch: process.arch,
  };
}

/**
 * Show the first-run notice if the user hasn't been notified yet.
 */
function showFirstRunNotice(): void {
  if (wasNotified()) {
    return;
  }

  // Don't show notice if disabled by env
  if (isDisabledByEnv()) {
    markNotified();
    return;
  }

  console.log('');
  console.log('Agent Relay collects anonymous usage data to improve the product.');
  console.log('Run `agent-relay telemetry disable` to opt out.');
  console.log('Learn more: https://agent-relay.com/telemetry');
  console.log('');

  markNotified();
}

/**
 * Initialize the telemetry client.
 * Should be called once at application startup.
 *
 * @param options.showNotice - Whether to show the first-run notice (default: true)
 */
export function initTelemetry(options: { showNotice?: boolean } = {}): void {
  if (initialized) {
    return;
  }

  initialized = true;

  // Show first-run notice if requested
  if (options.showNotice !== false) {
    showFirstRunNotice();
  }

  // Skip initialization if disabled
  if (!isTelemetryEnabled()) {
    return;
  }

  // Get PostHog configuration
  const posthogConfig = getPostHogConfig();
  if (!posthogConfig) {
    // No API key configured
    return;
  }

  // Initialize PostHog client
  client = new PostHog(posthogConfig.apiKey, {
    host: posthogConfig.host,
    // Flush events in batches for efficiency
    flushAt: 10,
    flushInterval: 10000, // 10 seconds
  });

  // Build common properties once
  commonProps = buildCommonProperties();

  // Get anonymous ID
  anonymousId = getAnonymousId();
}

/**
 * Track a telemetry event.
 * Type-safe: event name must match one of the defined events,
 * and properties must match the event's schema.
 *
 * @param event - The event name
 * @param properties - Event-specific properties
 */
export function track<E extends TelemetryEventName>(
  event: E,
  properties?: TelemetryEventMap[E]
): void {
  if (!client || !commonProps || !anonymousId) {
    return;
  }

  client.capture({
    distinctId: anonymousId,
    event,
    properties: {
      ...commonProps,
      ...properties,
    },
  });
}

/**
 * Flush pending events and shutdown the telemetry client.
 * Should be called before application exit.
 */
export async function shutdown(): Promise<void> {
  if (!client) {
    return;
  }

  try {
    await client.shutdown();
  } catch {
    // Silently fail - telemetry shouldn't break the app
  } finally {
    client = null;
    commonProps = null;
    anonymousId = null;
    initialized = false;
  }
}

/**
 * Check if telemetry is currently enabled.
 */
export function isEnabled(): boolean {
  return isTelemetryEnabled();
}

/**
 * Get the current anonymous ID.
 */
export { getAnonymousId };

/**
 * Get the current telemetry status for display.
 */
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
