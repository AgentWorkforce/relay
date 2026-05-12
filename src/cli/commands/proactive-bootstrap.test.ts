import assert from 'node:assert/strict';
import { Command } from 'commander';
import { describe, it, vi, beforeEach } from 'vitest';

const {
  createWorkspaceMock,
  defaultApiUrlMock,
  ensureAuthenticatedMock,
  issueWorkspaceTokenMock,
  readStoredAuthMock,
} = vi.hoisted(() => ({
  createWorkspaceMock: vi.fn(),
  defaultApiUrlMock: vi.fn(() => 'https://cloud.test'),
  ensureAuthenticatedMock: vi.fn(),
  issueWorkspaceTokenMock: vi.fn(),
  readStoredAuthMock: vi.fn(),
}));

vi.mock('@agent-relay/cloud', () => ({
  REFRESH_WINDOW_MS: 5 * 60_000,
  createWorkspace: (...args: unknown[]) => createWorkspaceMock(...args),
  defaultApiUrl: () => defaultApiUrlMock(),
  ensureAuthenticated: (...args: unknown[]) => ensureAuthenticatedMock(...args),
  issueWorkspaceToken: (...args: unknown[]) => issueWorkspaceTokenMock(...args),
  readStoredAuth: (...args: unknown[]) => readStoredAuthMock(...args),
}));

import {
  registerProactiveBootstrapCommands,
  type ProactiveBootstrapDependencies,
} from './proactive-bootstrap.js';

function createHarness() {
  const lines: string[] = [];
  const errors: string[] = [];
  const program = new Command();
  registerProactiveBootstrapCommands(program, {
    log: (...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(' '));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(' '));
    },
    exit: ((code: number) => {
      throw new Error(`exit:${code}`);
    }) as ProactiveBootstrapDependencies['exit'],
  });

  return { program, lines, errors };
}

describe('proactive bootstrap commands', () => {
  beforeEach(() => {
    createWorkspaceMock.mockReset();
    defaultApiUrlMock.mockReset();
    defaultApiUrlMock.mockReturnValue('https://cloud.test');
    ensureAuthenticatedMock.mockReset();
    issueWorkspaceTokenMock.mockReset();
    readStoredAuthMock.mockReset();
  });

  it('prints RELAY_API_KEY output for tokens issue', async () => {
    issueWorkspaceTokenMock.mockResolvedValue({
      key: 'relay_ws_live_support',
      workspaceToken: { workspaceId: 'support', kind: 'workspace_token' },
    });

    const { program, lines, errors } = createHarness();
    await program.parseAsync(['node', 'agent-relay', 'tokens', 'issue', '--workspace', 'support']);

    assert.deepEqual(errors, []);
    assert.deepEqual(lines, [
      'RELAY_API_KEY=relay_ws_live_support',
      'Export this value before starting SDK-backed proactive runtime commands.',
    ]);
    assert.deepEqual(issueWorkspaceTokenMock.mock.calls, [['support', { apiUrl: undefined }]]);
  });

  it('prints a success line after fresh login', async () => {
    readStoredAuthMock.mockResolvedValue(null);
    ensureAuthenticatedMock.mockResolvedValue({
      apiUrl: 'https://cloud.test',
      accessToken: 'access_token_test',
      refreshToken: 'refresh_token_test',
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const { program, lines, errors } = createHarness();
    await program.parseAsync(['node', 'agent-relay', 'login', '--api-url', 'https://cloud.test', '--force']);

    assert.deepEqual(errors, []);
    assert.deepEqual(lines, ['Logged in to https://cloud.test']);
    assert.deepEqual(ensureAuthenticatedMock.mock.calls, [['https://cloud.test', { force: true }]]);
  });

  it('surfaces workspace-create failures without a raw stack trace', async () => {
    createWorkspaceMock.mockRejectedValue(new Error('Workspace name is invalid'));

    const { program, errors } = createHarness();
    await assert.rejects(
      program.parseAsync(['node', 'agent-relay', 'workspaces', 'create', '!!!']),
      /exit:1/
    );

    assert.deepEqual(errors, ['Workspace name is invalid']);
  });
});
