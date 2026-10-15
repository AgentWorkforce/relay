/**
 * Telemetry preference storage (~/.agentworkforce/relay/telemetry.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface TelemetryPrefs {
  /** Whether telemetry is enabled (default: true) */
  enabled: boolean;
  /** ISO timestamp when user was shown the first-run notice */
  notifiedAt?: string;
  /** Legacy identifier retained on disk for compatibility; never aliased. */
  distinctId: string;
  /** Legacy profile-enqueue marker, removed when preferences are migrated. */
  identifiedFingerprint?: string;
  /** Random ID for one anonymous authentication generation, never a machine. */
  authGeneration?: string;
  authUserId?: string;
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
      const distinctId = prefs.distinctId ?? prefs.anonymousId ?? randomUUID();
      const normalized: TelemetryPrefs = {
        enabled: prefs.enabled ?? true,
        notifiedAt: prefs.notifiedAt,
        distinctId,
        authGeneration: prefs.authGeneration ?? randomUUID(),
        ...(prefs.authUserId ? { authUserId: prefs.authUserId } : {}),
      };

      if (
        prefs.distinctId !== distinctId ||
        prefs.anonymousId !== undefined ||
        !prefs.authGeneration ||
        prefs.identifiedFingerprint
      ) {
        savePrefs(normalized);
      }

      return normalized;
    }
  } catch {
    // An unreadable existing preference file may contain an opt-out. Never
    // replace it with enabled defaults, even if another writer repairs it.
    return { enabled: false, distinctId: randomUUID(), authGeneration: randomUUID() };
  }

  const prefs = { enabled: true, distinctId: randomUUID(), authGeneration: randomUUID() };
  savePrefs(prefs);
  return prefs;
}

export function savePrefs(prefs: TelemetryPrefs): void {
  const prefsPath = getPrefsPath();
  const configDir = path.dirname(prefsPath);

  const temporaryPath = `${prefsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(temporaryPath, JSON.stringify(prefs, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temporaryPath, prefsPath);
  } catch (err) {
    // Silently fail - telemetry shouldn't break the app
    console.error('[telemetry] Failed to save preferences:', err);
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      /* Best effort. */
    }
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
  prefs.authGeneration = randomUUID();
  delete prefs.authUserId;
  delete prefs.identifiedFingerprint;
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
  return loadPrefs().authGeneration!;
}

/** Rotate before assigning a generation to a different account, including logout. */
export function syncAuthGeneration(userId?: string): string {
  const prefs = loadPrefs();
  if (prefs.authUserId !== userId) {
    if (prefs.authUserId) prefs.authGeneration = randomUUID();
    prefs.authUserId = userId;
    savePrefs(prefs);
  }
  return prefs.authGeneration!;
}
