/**
 * Telemetry preference storage (~/.agentworkforce/relay/telemetry.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDistinctId } from './machine-id.js';

export interface TelemetryPrefs {
  /** Whether telemetry is enabled (default: true) */
  enabled: boolean;
  /** ISO timestamp when user was shown the first-run notice */
  notifiedAt?: string;
  /**
   * Stable hashed machine identifier. Used as the PostHog distinctId for
   * anonymous runs, and as the alias merged into the cloud user id once the
   * operator logs in.
   */
  distinctId: string;
  /**
   * Fingerprint of the cloud identity we last sent `$identify` /
   * `$groupidentify` for. Lets us re-issue them when the user switches org (or
   * their email changes) while skipping them on every other run.
   */
  identifiedFingerprint?: string;
}

type StoredTelemetryPrefs = Partial<TelemetryPrefs> & { anonymousId?: string };

export function getPrefsPath(): string {
  const configDir = process.env.AGENT_RELAY_DATA_DIR || path.join(os.homedir(), '.agentworkforce/relay');
  return path.join(configDir, 'telemetry.json');
}

export function loadPrefs(): TelemetryPrefs {
  const prefsPath = getPrefsPath();

  try {
    if (fs.existsSync(prefsPath)) {
      const content = fs.readFileSync(prefsPath, 'utf-8');
      const prefs = JSON.parse(content) as StoredTelemetryPrefs;
      const distinctId = prefs.distinctId ?? prefs.anonymousId ?? createDistinctId();
      const normalized: TelemetryPrefs = {
        enabled: prefs.enabled ?? true,
        notifiedAt: prefs.notifiedAt,
        distinctId,
        ...(prefs.identifiedFingerprint
          ? { identifiedFingerprint: prefs.identifiedFingerprint }
          : {}),
      };

      if (prefs.distinctId !== distinctId || prefs.anonymousId !== undefined) {
        savePrefs(normalized);
      }

      return normalized;
    }
  } catch {
    // Fall through to defaults
  }

  return {
    enabled: true,
    distinctId: createDistinctId(),
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

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function isDisabledByEnv(): boolean {
  return isTruthyEnv(process.env.AGENT_RELAY_TELEMETRY_DISABLED) || isTruthyEnv(process.env.DO_NOT_TRACK);
}

/**
 * Check if telemetry is enabled.
 * Order of precedence:
 * 1. AGENT_RELAY_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1 -> disabled
 * 2. ~/.agentworkforce/relay/telemetry.json -> use stored pref
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

export function getDistinctId(): string {
  return loadPrefs().distinctId;
}

/** Fingerprint of the last cloud identity we announced to PostHog, if any. */
export function getIdentifiedFingerprint(): string | undefined {
  return loadPrefs().identifiedFingerprint;
}

export function markIdentified(fingerprint: string): void {
  const prefs = loadPrefs();
  prefs.identifiedFingerprint = fingerprint;
  savePrefs(prefs);
}
