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

function buildCommonProperties(): CommonProperties {
  return {
    agent_relay_version: getVersion(),
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
  console.log('Learn more: https://agent-relay.com/telemetry');
  console.log('');

  markNotified();
}

export function initTelemetry(options: { showNotice?: boolean } = {}): void {
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
  });

  commonProps = buildCommonProperties();
  anonymousId = getAnonymousId();
}

export function track<E extends TelemetryEventName>(
  event: E,
  properties?: TelemetryEventMap[E]
): void {
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
