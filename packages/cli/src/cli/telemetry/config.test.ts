import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  disableTelemetry,
  enableTelemetry,
  getDistinctId,
  getPrefsPath,
  isDisabledByEnv,
  isTelemetryEnabled,
  loadPrefs,
  markNotified,
  savePrefs,
  wasNotified,
} from './config.js';

describe('telemetry preferences', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-telemetry-prefs-'));
    vi.stubEnv('AGENT_RELAY_DATA_DIR', dataDir);
    vi.stubEnv('AGENT_RELAY_TELEMETRY_DISABLED', '');
    vi.stubEnv('DO_NOT_TRACK', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates default enabled preferences with a stable distinct id', () => {
    const prefs = loadPrefs();

    expect(prefs.enabled).toBe(true);
    expect(prefs.notifiedAt).toBeUndefined();
    expect(prefs.authGeneration).toMatch(/^[a-f0-9-]{36}$/);
    expect(getDistinctId()).toBe(prefs.authGeneration);
  });

  it('loads legacy anonymous ids and writes the normalized field', () => {
    fs.mkdirSync(path.dirname(getPrefsPath()), { recursive: true });
    fs.writeFileSync(
      getPrefsPath(),
      JSON.stringify({
        enabled: false,
        notifiedAt: '2026-06-03T00:00:00.000Z',
        anonymousId: 'legacy-id',
      }),
      'utf-8'
    );

    expect(loadPrefs()).toEqual({
      enabled: false,
      notifiedAt: '2026-06-03T00:00:00.000Z',
      distinctId: 'legacy-id',
      authGeneration: expect.any(String),
    });
    expect(JSON.parse(fs.readFileSync(getPrefsPath(), 'utf-8'))).toEqual({
      enabled: false,
      notifiedAt: '2026-06-03T00:00:00.000Z',
      distinctId: 'legacy-id',
      authGeneration: expect.any(String),
    });
  });

  it('honors environment opt-out before stored preferences', () => {
    savePrefs({ enabled: true, distinctId: 'stored-id' });

    vi.stubEnv('AGENT_RELAY_TELEMETRY_DISABLED', 'true');
    expect(isDisabledByEnv()).toBe(true);
    expect(isTelemetryEnabled()).toBe(false);

    vi.stubEnv('AGENT_RELAY_TELEMETRY_DISABLED', '0');
    vi.stubEnv('DO_NOT_TRACK', '1');
    expect(isDisabledByEnv()).toBe(true);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('persists enable, disable, and first-run notification state', () => {
    disableTelemetry();
    expect(loadPrefs().enabled).toBe(false);
    expect(isTelemetryEnabled()).toBe(false);

    enableTelemetry();
    expect(loadPrefs().enabled).toBe(true);
    expect(isTelemetryEnabled()).toBe(true);
    expect(wasNotified()).toBe(false);

    markNotified();
    expect(wasNotified()).toBe(true);
    expect(loadPrefs().notifiedAt).toEqual(expect.any(String));
  });
  it('never overwrites unreadable existing preferences with enabled defaults', () => {
    fs.writeFileSync(getPrefsPath(), '{"enabled":false');
    expect(loadPrefs().enabled).toBe(false);
    expect(fs.readFileSync(getPrefsPath(), 'utf8')).toBe('{"enabled":false');
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('replaces preferences atomically so readers observe the complete previous snapshot', () => {
    savePrefs({ enabled: false, distinctId: 'generation' });
    const write = fs.writeFileSync;
    let observed: unknown;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file, data, options) => {
      observed = JSON.parse(fs.readFileSync(getPrefsPath(), 'utf8'));
      expect(String(file)).not.toBe(getPrefsPath());
      return write(file, data, options);
    }) as typeof fs.writeFileSync);
    savePrefs({ enabled: true, distinctId: 'generation' });
    expect(observed).toMatchObject({ enabled: false });
    expect(JSON.parse(fs.readFileSync(getPrefsPath(), 'utf8'))).toMatchObject({ enabled: true });
    expect(fs.readdirSync(dataDir)).toEqual(['telemetry.json']);
  });
});
