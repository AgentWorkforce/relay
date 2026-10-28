import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  identify: vi.fn(),
  alias: vi.fn(),
  groupIdentify: vi.fn(),
  shutdown: vi.fn(async () => undefined),
  setPersistedProperty: vi.fn(),
}));

vi.mock('posthog-node', () => ({
  PostHog: vi.fn(function () {
    return {
      capture: posthogMocks.capture,
      identify: posthogMocks.identify,
      alias: posthogMocks.alias,
      groupIdentify: posthogMocks.groupIdentify,
      shutdown: posthogMocks.shutdown,
      setPersistedProperty: posthogMocks.setPersistedProperty,
    };
  }),
}));

import { writeStoredIdentity, clearStoredIdentity, type CloudIdentity } from '@agent-relay/cloud/identity';
import { createDistinctId } from './machine-id.js';
import { getDistinctId, disableTelemetry } from './config.js';
import { initTelemetry, shutdown, track, getStatus } from './client.js';

const IDENTITY: CloudIdentity = {
  userId: 'usr_abc123',
  email: 'will@agentrelay.com',
  name: 'Will',
  organizationId: 'org_xyz789',
  organizationSlug: 'agentworkforce',
  organizationName: 'Agent Workforce',
  organizationRole: 'owner',
  workspaceId: 'ws_123',
  apiUrl: 'https://api.agentrelay.com',
  updatedAt: '2026-07-25T00:00:00.000Z',
};

describe('telemetry client events', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-telemetry-client-'));
    vi.stubEnv('AGENT_RELAY_DATA_DIR', dataDir);
    vi.stubEnv('POSTHOG_API_KEY', 'test-key');
    vi.stubEnv('AGENT_RELAY_POSTHOG_KEY', '');
    vi.stubEnv('POSTHOG_HOST', '');
    vi.stubEnv('AGENT_RELAY_TELEMETRY_DISABLED', '');
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('AGENT_RELAY_USER_ID', '');
    vi.stubEnv('AGENT_RELAY_ORG_ID', '');
    vi.stubEnv('AGENT_RELAY_ORG_SLUG', '');
    vi.stubEnv('AGENT_RELAY_USER_EMAIL', '');
    vi.stubEnv('AGENT_RELAY_MACHINE_ID', '');
    posthogMocks.capture.mockClear();
    posthogMocks.identify.mockClear();
    posthogMocks.alias.mockClear();
    posthogMocks.groupIdentify.mockClear();
    posthogMocks.shutdown.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await shutdown();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('tracks cli_install on first telemetry initialization only', async () => {
    initTelemetry({
      cliVersion: '1.2.3',
      orchestratorHarness: 'claude/opus-48',
    });

    expect(posthogMocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: expect.any(String),
        event: 'cli_install',
        properties: expect.objectContaining({
          cli_version: '1.2.3',
          orchestrator_harness: 'claude/opus-48',
          version: '1.2.3',
          success: true,
        }),
      })
    );

    await shutdown();
    posthogMocks.capture.mockClear();

    initTelemetry({
      cliVersion: '1.2.3',
      orchestratorHarness: 'claude/opus-48',
    });

    expect(posthogMocks.capture).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'cli_install' }));
  });

  it('writes the first-run notice to stderr so JSON stdout stays parseable', () => {
    initTelemetry({ cliVersion: '1.2.3' });

    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Agent Relay collects usage telemetry to improve the product.'
    );
  });

  describe('anonymous (not logged in)', () => {
    it('keys events by a random auth generation and marks them unauthenticated', () => {
      const machineDistinctId = getDistinctId();
      initTelemetry({ cliVersion: '1.2.3' });
      posthogMocks.capture.mockClear();

      track('cli_command_run', { command_name: 'up', flags: [] });

      expect(posthogMocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: machineDistinctId,
          properties: expect.objectContaining({ is_authenticated: false }),
        })
      );
      const [call] = posthogMocks.capture.mock.calls.at(-1)!;
      expect(call.properties.user_id).toBeUndefined();
      expect(call.groups).toBeUndefined();
    });

    it('still reports the machine id', () => {
      const machineDistinctId = createDistinctId();
      initTelemetry({ cliVersion: '1.2.3' });
      posthogMocks.capture.mockClear();

      track('cli_command_run', { command_name: 'up', flags: [] });

      const [call] = posthogMocks.capture.mock.calls.at(-1)!;
      expect(call.properties.machine_id).toBe(machineDistinctId);
      expect(call.distinctId).not.toBe(machineDistinctId);
    });

    it('does not identify or create groups', () => {
      initTelemetry({ cliVersion: '1.2.3' });
      expect(posthogMocks.identify).not.toHaveBeenCalled();
      expect(posthogMocks.alias).not.toHaveBeenCalled();
      expect(posthogMocks.groupIdentify).not.toHaveBeenCalled();
    });
  });

  describe('signed in', () => {
    it('keys events by the cloud user id and tags user, org, and group', async () => {
      await writeStoredIdentity(IDENTITY, process.env);
      initTelemetry({ cliVersion: '1.2.3' });
      posthogMocks.capture.mockClear();

      track('cli_command_run', { command_name: 'up', flags: [] });

      expect(posthogMocks.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: 'usr_abc123',
          groups: { organization: 'org_xyz789', workspace: 'ws_123' },
          properties: expect.objectContaining({
            is_authenticated: true,
            user_id: 'usr_abc123',
            organization_id: 'org_xyz789',
            organization_slug: 'agentworkforce',
          }),
        })
      );
    });

    it('never puts the email in event properties — it is a person property', async () => {
      await writeStoredIdentity(IDENTITY, process.env);
      initTelemetry({ cliVersion: '1.2.3' });
      posthogMocks.capture.mockClear();

      track('cli_command_run', { command_name: 'up', flags: [] });

      const [call] = posthogMocks.capture.mock.calls.at(-1)!;
      expect(JSON.stringify(call.properties)).not.toContain('will@agentrelay.com');
      expect(posthogMocks.identify).not.toHaveBeenCalled();
    });

    it('never aliases durable machine identity or writes cached PII, even after failure/restart', async () => {
      await writeStoredIdentity(IDENTITY);
      initTelemetry({ cliVersion: '1.2.3' });
      posthogMocks.shutdown.mockRejectedValueOnce(new Error('network unavailable'));
      await shutdown();
      initTelemetry({ cliVersion: '1.2.3' });
      track('cli_command_run', { command_name: 'status' });
      expect(posthogMocks.alias).not.toHaveBeenCalled();
      expect(posthogMocks.identify).not.toHaveBeenCalled();
      expect(posthogMocks.capture).toHaveBeenLastCalledWith(
        expect.objectContaining({ distinctId: IDENTITY.userId })
      );
    });

    it('reconciles login, workspace switch, logout, and account switch without restart', async () => {
      initTelemetry({ cliVersion: '1.2.3', showNotice: false });
      track('cli_command_run', { command_name: 'login' });
      const anonymousA = posthogMocks.capture.mock.calls.at(-1)![0].distinctId;
      await writeStoredIdentity(IDENTITY);
      track('cli_cloud_auth_command', { action: 'login', success: true, duration_ms: 1 });
      expect(posthogMocks.capture.mock.calls.at(-1)![0].distinctId).toBe(IDENTITY.userId);
      await writeStoredIdentity({ ...IDENTITY, organizationId: undefined, workspaceId: 'ws_other' });
      track('cli_command_run', { command_name: 'status' });
      const switched = posthogMocks.capture.mock.calls.at(-1)![0];
      expect(switched.groups).toEqual({ workspace: 'ws_other' });
      expect(switched.properties.organization_id).toBeUndefined();
      expect(process.env.AGENT_RELAY_ORG_ID).toBeUndefined();
      await clearStoredIdentity();
      track('cli_command_run', { command_name: 'logout' });
      const anonymousB = posthogMocks.capture.mock.calls.at(-1)![0].distinctId;
      expect(anonymousB).not.toBe(anonymousA);
      expect(process.env.AGENT_RELAY_USER_ID).toBeUndefined();
      await writeStoredIdentity({ ...IDENTITY, userId: 'usr_B' });
      track('cli_command_run', { command_name: 'status' });
      expect(posthogMocks.capture.mock.calls.at(-1)![0].distinctId).toBe('usr_B');
      expect(posthogMocks.alias).not.toHaveBeenCalled();
    });

    it('does not let inherited IDs override the current login', async () => {
      await writeStoredIdentity(IDENTITY);
      vi.stubEnv('AGENT_RELAY_USER_ID', 'usr_from_env');
      initTelemetry({ cliVersion: '1.2.3' });
      track('cli_command_run', { command_name: 'up' });
      expect(posthogMocks.capture.mock.calls.at(-1)![0].distinctId).toBe(IDENTITY.userId);
    });

    it('discards queued events and child identity when disabled mid-process', async () => {
      await writeStoredIdentity(IDENTITY);
      initTelemetry({ showNotice: false });
      track('cli_command_run', { command_name: 'up' });
      const captures = posthogMocks.capture.mock.calls.length;
      disableTelemetry();
      track('cli_command_run', { command_name: 'status' });
      expect(posthogMocks.capture).toHaveBeenCalledTimes(captures);
      expect(posthogMocks.setPersistedProperty).toHaveBeenCalledWith('queue', []);
      expect(process.env.AGENT_RELAY_USER_ID).toBeUndefined();
      expect(process.env.AGENT_RELAY_USER_EMAIL).toBeUndefined();
    });

    it('does not credit the local account when env-backed credentials select another session', async () => {
      await writeStoredIdentity(IDENTITY);
      vi.stubEnv('CLOUD_API_ACCESS_TOKEN', 'synthetic-B');
      initTelemetry({ showNotice: false });
      track('cli_command_run', { command_name: 'status' });
      const event = posthogMocks.capture.mock.calls.at(-1)![0];
      expect(event.distinctId).not.toBe(IDENTITY.userId);
      expect(event.properties.user_id).toBeUndefined();
      expect(event.groups).toBeUndefined();
    });

    it('honors an explicit anonymous override', async () => {
      await writeStoredIdentity(IDENTITY, process.env);
      initTelemetry({ cliVersion: '1.2.3', identity: null });

      expect(posthogMocks.identify).not.toHaveBeenCalled();
      posthogMocks.capture.mockClear();
      track('cli_command_run', { command_name: 'up', flags: [] });
      const [call] = posthogMocks.capture.mock.calls.at(-1)!;
      expect(call.properties.is_authenticated).toBe(false);
    });

    it('keeps the machine id as its own property so machine cross-tabs survive', async () => {
      const machineDistinctId = createDistinctId();
      await writeStoredIdentity(IDENTITY, process.env);
      initTelemetry({ cliVersion: '1.2.3' });
      posthogMocks.capture.mockClear();

      track('cli_command_run', { command_name: 'up', flags: [] });

      const [call] = posthogMocks.capture.mock.calls.at(-1)!;
      // distinct_id is the person; machine_id is a separate dimension. Without
      // both, "how many machines is this account on" is unanswerable.
      expect(call.distinctId).toBe('usr_abc123');
      expect(call.properties.machine_id).toBe(machineDistinctId);
      expect(call.properties.cloud_workspace_id).toBe('ws_123');
    });

    it('reports the identity in telemetry status', async () => {
      await writeStoredIdentity(IDENTITY, process.env);
      expect(getStatus()).toMatchObject({
        distinctId: 'usr_abc123',
        userId: 'usr_abc123',
        email: 'will@agentrelay.com',
        organizationSlug: 'agentworkforce',
      });
    });
  });
});
