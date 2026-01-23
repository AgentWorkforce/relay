/**
 * Telemetry preference storage (~/.agent-relay/telemetry.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createAnonymousId } from './machine-id.js';

export interface TelemetryPrefs {
  /** Whether telemetry is enabled (default: true) */
  enabled: boolean;
  /** ISO timestamp when user was shown the first-run notice */
  notifiedAt?: string;
  /** Anonymous ID derived from machine-id hash */
  anonymousId: string;
}

export function getPrefsPath(): string {
  const configDir = process.env.AGENT_RELAY_DATA_DIR ||
    path.join(os.homedir(), '.agent-relay');
  return path.join(configDir, 'telemetry.json');
}

export function loadPrefs(): TelemetryPrefs {
  const prefsPath = getPrefsPath();

  try {
    if (fs.existsSync(prefsPath)) {
      const content = fs.readFileSync(prefsPath, 'utf-8');
      const prefs = JSON.parse(content) as Partial<TelemetryPrefs>;

      if (!prefs.anonymousId) {
        prefs.anonymousId = createAnonymousId();
        savePrefs(prefs as TelemetryPrefs);
      }

      return {
        enabled: prefs.enabled ?? true,
        notifiedAt: prefs.notifiedAt,
        anonymousId: prefs.anonymousId,
      };
    }
  } catch {
    // Fall through to defaults
  }

  return {
    enabled: true,
    anonymousId: createAnonymousId(),
  };
}

export function savePrefs(prefs: TelemetryPrefs): void {
  const prefsPath = getPrefsPath();
  const configDir = path.dirname(prefsPath);

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf-8');
  } catch (err) {
    // Silently fail - telemetry shouldn't break the app
    console.error('[telemetry] Failed to save preferences:', err);
  }
}

export function isDisabledByEnv(): boolean {
  const envValue = process.env.AGENT_RELAY_TELEMETRY_DISABLED;
  return envValue === '1' || envValue === 'true';
}

/**
 * Check if telemetry is enabled.
 * Order of precedence:
 * 1. AGENT_RELAY_TELEMETRY_DISABLED=1 -> disabled
 * 2. ~/.agent-relay/telemetry.json -> use stored pref
 * 3. Default -> enabled
 */
export function isTelemetryEnabled(): boolean {
  if (isDisabledByEnv()) {
    return false;
  }
  return loadPrefs().enabled;
}

export function enableTelemetry(): void {
  const prefs = loadPrefs();
  prefs.enabled = true;
  savePrefs(prefs);
}

export function disableTelemetry(): void {
  const prefs = loadPrefs();
  prefs.enabled = false;
  savePrefs(prefs);
}

export function markNotified(): void {
  const prefs = loadPrefs();
  prefs.notifiedAt = new Date().toISOString();
  savePrefs(prefs);
}

export function wasNotified(): boolean {
  return loadPrefs().notifiedAt !== undefined;
}

export function getAnonymousId(): string {
  return loadPrefs().anonymousId;
}
