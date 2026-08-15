import { describe, expect, it } from 'vitest';

import { maskSecret, redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('redacts credential-named fields and preserves the rest', () => {
    const redacted = redactSecrets({
      broker: {
        running: true,
        brokerVersion: '9.2.3',
        protocolVersion: 2,
        nodeId: 'node_1',
        nodeName: 'live-node',
        workspaceKey: 'rk_live_secret',
        nodeToken: 'nt_live_secret',
      },
      node: { name: 'live-node', status: 'online' },
    });

    expect(redacted.broker.workspaceKey).toBe('[redacted]');
    expect(redacted.broker.nodeToken).toBe('[redacted]');
    // Non-secret fields survive unchanged.
    expect(redacted.broker.brokerVersion).toBe('9.2.3');
    expect(redacted.broker.nodeId).toBe('node_1');
    expect(redacted.node).toEqual({ name: 'live-node', status: 'online' });
  });

  it('leaves an absent secret field absent (does not fabricate a value)', () => {
    expect(redactSecrets({ workspace_key: null, node_token: undefined })).toEqual({
      workspace_key: null,
      node_token: undefined,
    });
  });

  it('never leaks a live-token substring for any session shape', () => {
    const output = JSON.stringify(
      redactSecrets({
        workspace_key: 'rk_live_abc',
        node_token: 'nt_live_xyz',
        authorization: 'Bearer nt_live_xyz',
        nested: [{ apiKey: 'rk_live_def' }],
      })
    );
    expect(output).not.toMatch(/rk_live_|nt_live_/);
  });

  it('emits [circular] instead of overflowing on a self-referential value', () => {
    const cyclic: Record<string, unknown> = { name: 'node', token: 'nt_live_secret' };
    cyclic.self = cyclic;

    const redacted = redactSecrets(cyclic) as Record<string, unknown>;
    expect(redacted.token).toBe('[redacted]');
    expect(redacted.self).toBe('[circular]');
  });

  it('redacts a shared (non-cyclic) reference at every occurrence without mutating the input', () => {
    const creds = { apiKey: 'rk_live_shared' };
    const input = { a: creds, b: creds };
    const redacted = redactSecrets(input) as {
      a: { apiKey: string };
      b: { apiKey: string };
    };
    // A DAG-shared object is a real value, not a cycle: redact both, never [circular].
    expect(redacted.a.apiKey).toBe('[redacted]');
    expect(redacted.b.apiKey).toBe('[redacted]');
    // Redaction is a deep copy: the caller's original object is untouched.
    expect(creds.apiKey).toBe('rk_live_shared');
    expect(input.a).toBe(creds);
  });
});

describe('maskSecret', () => {
  it('keeps a known prefix and the last four characters', () => {
    expect(maskSecret('rk_live_0123456789abcdef')).toBe('rk_live_…cdef');
    expect(maskSecret('rjt_live_0123456789abcdef')).toBe('rjt_live_…cdef');
    expect(maskSecret('at_live_0123456789abcdef')).toBe('at_live_…cdef');
    expect(maskSecret('nt_live_0123456789abcdef')).toBe('nt_live_…cdef');
    expect(maskSecret('cld_at_0123456789abcdef')).toBe('cld_at_…cdef');
  });

  it('masks the entire body when it is too short to show a suffix', () => {
    expect(maskSecret('rk_live_short')).toBe('rk_live_…');
    expect(maskSecret('tiny')).toBe('…');
  });

  it('masks unknown-shaped tokens to an ellipsis and the last four characters', () => {
    expect(maskSecret('some-opaque-access-token')).toBe('…oken');
  });
});
