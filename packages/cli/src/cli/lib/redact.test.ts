import { describe, expect, it } from 'vitest';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { maskSecret, maskSecretsInText, redactSecrets } from './redact.js';

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
  it('keeps the prefix of an armadillo credential and hides its body', () => {
    expect(maskSecret('ar_ws_0123456789abcdef')).toBe('ar_ws_…cdef');
    expect(maskSecret('ar_ag_0123456789abcdef')).toBe('ar_ag_…cdef');
  });

  it('redacts the shell redact() in scripts/try-relay-init.sh for armadillo credentials', () => {
    const script = fs.readFileSync(
      new URL('../../../../../scripts/try-relay-init.sh', import.meta.url),
      'utf8'
    );
    const redact = script.split('\n').find((line) => line.startsWith('redact() '));
    const output = execFileSync(
      'bash',
      ['-c', `${redact}\nprintf 'key ar_ws_abc123 token ar_ag_def456' | redact`],
      { encoding: 'utf8' }
    );
    expect(output).toBe('key ar_<redacted> token ar_<redacted>');
  });

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

describe('maskSecretsInText', () => {
  it('masks live credentials embedded anywhere in the text', () => {
    expect(maskSecretsInText('key rk_live_0123456789abcdef for "at_live_fedcba9876543210".')).toBe(
      'key rk_live_…cdef for "at_live_…3210".'
    );
    expect(maskSecretsInText('agent my_br_0123456789abcdef')).toBe('agent my_br_…cdef');
  });

  it('masks every occurrence of a known secret whatever its shape', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ3b3JrZXIifQ.c2lnbmF0dXJl';
    expect(maskSecretsInText(`${jwt} then '${jwt}'`, [jwt])).toBe(`…dXJl then '…dXJl'`);
  });

  it('masks a known secret whole when it contains another', () => {
    expect(maskSecretsInText('opaque-token-0123456789', ['opaque-token', 'opaque-token-0123456789'])).toBe(
      '…6789'
    );
  });

  it.each([
    ['a GitHub token', `ghp_${'a1B2'.repeat(9)}`, '…a1B2'],
    ['a GitHub fine-grained token', `github_pat_${'A1'.repeat(11)}_${'b2'.repeat(29)}c`, '…2b2c'],
    [
      'a Slack token',
      ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-'),
      '…UvWx',
    ],
    [
      'a Slack user token',
      ['xoxp', '1234567890', '1234567890', '1234567890', 'a1b2c3d4'.repeat(4)].join('-'),
      '…c3d4',
    ],
    ['an AWS access key ID', ['AKIA', 'IOSFODNN7EXAMPLE'].join(''), '…MPLE'],
    ['an Anthropic key', `sk-ant-api03-${'Xy9_'.repeat(23)}AA`, '…9_AA'],
    ['an OpenAI legacy key', `sk-${'Ab3'.repeat(16)}`, '…3Ab3'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJib3QifQ.c2lnbmF0dXJl', '…dXJl'],
  ])('masks %s embedded in the text', (_kind, secret, masked) => {
    expect(maskSecretsInText(`agent "${secret}" failed`)).toBe(`agent "${masked}" failed`);
  });

  it('masks the userinfo of a URL', () => {
    expect(maskSecretsInText('fetch https://user:hunter22@relay.example/v1 and http://token@h:8080')).toBe(
      'fetch https://…@relay.example/v1 and http://…@h:8080'
    );
    // A URL parser splits at the last `@`, so an unencoded one belongs to the password.
    expect(maskSecretsInText('https://ops:p@ss@word@relay.example/v1')).toBe('https://…@relay.example/v1');
    expect(maskSecretsInText('mail ops@relay.example, see https://relay.example/@team')).toBe(
      'mail ops@relay.example, see https://relay.example/@team'
    );
  });

  it('leaves ordinary words alone, including ones that contain a prefix', () => {
    // `redactCredentialValues` masks the last three, since it matches a prefix anywhere.
    const text =
      'task-runner desk-bot sk-reviewer Bearer-of-news "WorkerA" cobr_worker chat_live_bot solar_ws_bot';
    expect(maskSecretsInText(text, [undefined, 'short'])).toBe(text);
  });

  it('leaves names that only resemble a third-party format alone', () => {
    const text = [
      'ghp_reviewer',
      'gho_builder',
      'github_pat_bot',
      'xoxb-bot',
      'xoxb-202611-build',
      'xoxb-20261123-nightly-build-for-the-release-train',
      'AKIA-bot',
      'sk-ant-helper',
      'sk-proj-planner',
      'sk-reviewer-for-the-billing-service-team-2026',
      'eyJ-bot',
      'release.eyJ.v2',
    ].join(' ');
    expect(maskSecretsInText(text)).toBe(text);
  });
});
