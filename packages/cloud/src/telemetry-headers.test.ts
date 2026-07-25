import { describe, expect, it } from 'vitest';

import {
  AGENT_RELAY_DISTINCT_ID_HEADER,
  AGENT_RELAY_MACHINE_ID_HEADER,
  AGENT_RELAY_ORG_ID_HEADER,
  AGENT_RELAY_ORG_SLUG_HEADER,
  AGENT_RELAY_USER_ID_HEADER,
  appendAgentRelayTelemetryHeaders,
  buildAgentRelayTelemetryHeaders,
} from './telemetry-headers.js';

describe('buildAgentRelayTelemetryHeaders', () => {
  it('forwards user and org identity alongside the distinct id', () => {
    expect(
      buildAgentRelayTelemetryHeaders({
        AGENT_RELAY_DISTINCT_ID: 'usr_abc123',
        AGENT_RELAY_USER_ID: 'usr_abc123',
        AGENT_RELAY_ORG_ID: 'org_xyz789',
        AGENT_RELAY_ORG_SLUG: 'agentworkforce',
      })
    ).toEqual({
      [AGENT_RELAY_DISTINCT_ID_HEADER]: 'usr_abc123',
      [AGENT_RELAY_USER_ID_HEADER]: 'usr_abc123',
      [AGENT_RELAY_ORG_ID_HEADER]: 'org_xyz789',
      [AGENT_RELAY_ORG_SLUG_HEADER]: 'agentworkforce',
    });
  });

  it('uses the user id as the distinct id when no distinct id is published', () => {
    const headers = buildAgentRelayTelemetryHeaders({ AGENT_RELAY_USER_ID: 'usr_abc123' });
    expect(headers[AGENT_RELAY_DISTINCT_ID_HEADER]).toBe('usr_abc123');
    expect(headers[AGENT_RELAY_USER_ID_HEADER]).toBe('usr_abc123');
  });

  it('still works for anonymous machines with only a distinct id', () => {
    expect(buildAgentRelayTelemetryHeaders({ AGENT_RELAY_DISTINCT_ID: 'abc123def4567890' })).toEqual(
      { [AGENT_RELAY_DISTINCT_ID_HEADER]: 'abc123def4567890' }
    );
  });

  it('sends nothing without any identity', () => {
    expect(buildAgentRelayTelemetryHeaders({})).toEqual({});
  });

  it('drops malformed identity values rather than forwarding them', () => {
    const headers = buildAgentRelayTelemetryHeaders({
      AGENT_RELAY_DISTINCT_ID: 'abc123def4567890',
      AGENT_RELAY_USER_ID: 'usr\r\nX-Inject: bad',
      AGENT_RELAY_ORG_ID: 'org/slash',
      AGENT_RELAY_ORG_SLUG: 'fine-slug',
    });

    expect(headers[AGENT_RELAY_USER_ID_HEADER]).toBeUndefined();
    expect(headers[AGENT_RELAY_ORG_ID_HEADER]).toBeUndefined();
    expect(headers[AGENT_RELAY_ORG_SLUG_HEADER]).toBe('fine-slug');
  });

  it('sends the machine id alongside the user id, not instead of it', () => {
    // The whole point: after login the distinct id is the user id, so the
    // machine dimension only survives as its own header.
    const headers = buildAgentRelayTelemetryHeaders({
      AGENT_RELAY_DISTINCT_ID: 'usr_abc123',
      AGENT_RELAY_USER_ID: 'usr_abc123',
      AGENT_RELAY_MACHINE_ID: 'abc123def4567890',
    });

    expect(headers[AGENT_RELAY_DISTINCT_ID_HEADER]).toBe('usr_abc123');
    expect(headers[AGENT_RELAY_USER_ID_HEADER]).toBe('usr_abc123');
    expect(headers[AGENT_RELAY_MACHINE_ID_HEADER]).toBe('abc123def4567890');
  });

  it('forwards the machine id for an anonymous caller', () => {
    expect(
      buildAgentRelayTelemetryHeaders({ AGENT_RELAY_MACHINE_ID: 'abc123def4567890' })
    ).toEqual({
      [AGENT_RELAY_DISTINCT_ID_HEADER]: 'abc123def4567890',
      [AGENT_RELAY_MACHINE_ID_HEADER]: 'abc123def4567890',
    });
  });

  it('honors the telemetry opt-out for identity too', () => {
    for (const env of [
      { AGENT_RELAY_TELEMETRY_DISABLED: '1' },
      { DO_NOT_TRACK: 'true' },
    ]) {
      expect(
        buildAgentRelayTelemetryHeaders({
          ...env,
          AGENT_RELAY_USER_ID: 'usr_abc123',
          AGENT_RELAY_ORG_ID: 'org_xyz789',
          AGENT_RELAY_MACHINE_ID: 'abc123def4567890',
        })
      ).toEqual({});
    }
  });
});

describe('appendAgentRelayTelemetryHeaders', () => {
  it('does not overwrite headers a caller already set', () => {
    const headers = new Headers({ [AGENT_RELAY_USER_ID_HEADER]: 'usr_explicit' });
    appendAgentRelayTelemetryHeaders(headers, {
      AGENT_RELAY_USER_ID: 'usr_env',
      AGENT_RELAY_ORG_ID: 'org_env',
    });

    expect(headers.get(AGENT_RELAY_USER_ID_HEADER)).toBe('usr_explicit');
    expect(headers.get(AGENT_RELAY_ORG_ID_HEADER)).toBe('org_env');
  });
});
