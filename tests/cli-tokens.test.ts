import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cloudMocks = vi.hoisted(() => ({
  issueWorkspaceToken: vi.fn(),
}));

vi.mock('@agent-relay/cloud', () => ({
  REFRESH_WINDOW_MS: 60_000,
  createWorkspace: vi.fn(),
  defaultApiUrl: () => 'https://cloud.test',
  ensureAuthenticated: vi.fn(),
  issueWorkspaceToken: (...args: unknown[]) => cloudMocks.issueWorkspaceToken(...args),
  readStoredAuth: vi.fn(),
}));

vi.mock('@agent-relay/telemetry', () => ({
  track: vi.fn(),
}));

import {
  registerProactiveBootstrapCommands,
  type ProactiveBootstrapDependencies,
} from '../src/cli/commands/proactive-bootstrap.js';

function createHarness() {
  const deps: ProactiveBootstrapDependencies = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as unknown as ProactiveBootstrapDependencies['exit'],
  };

  const program = new Command();
  registerProactiveBootstrapCommands(program, deps);

  return { program, deps };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('tokens issue', () => {
  it('issues a workspace token and prints the key by default', async () => {
    const { program, deps } = createHarness();
    cloudMocks.issueWorkspaceToken.mockResolvedValueOnce({
      key: 'relay_ws_live_support',
      workspaceToken: {
        workspaceId: 'support',
        kind: 'workspace_token',
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'tokens', 'issue', '--workspace', 'support']);

    expect(cloudMocks.issueWorkspaceToken).toHaveBeenCalledWith(
      'support',
      expect.objectContaining({ apiUrl: undefined })
    );
    expect(deps.log).toHaveBeenCalledWith('relay_ws_live_support');
  });

  it('prints the raw JSON payload when --json is set', async () => {
    const { program, deps } = createHarness();
    cloudMocks.issueWorkspaceToken.mockResolvedValueOnce({
      key: 'relay_ws_live_sales',
      workspaceToken: {
        workspaceId: 'sales',
        kind: 'workspace_token',
        name: 'workspace:sales',
      },
    });

    await program.parseAsync(['node', 'agent-relay', 'tokens', 'issue', '--workspace', 'sales', '--json']);

    expect(cloudMocks.issueWorkspaceToken).toHaveBeenCalledWith(
      'sales',
      expect.objectContaining({ apiUrl: undefined })
    );
    expect(deps.log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          key: 'relay_ws_live_sales',
          workspaceToken: {
            workspaceId: 'sales',
            kind: 'workspace_token',
            name: 'workspace:sales',
          },
        },
        null,
        2
      )
    );
  });
});
