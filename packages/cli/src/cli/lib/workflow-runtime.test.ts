import { describe, expect, it, vi } from 'vitest';

import {
  describeWorkflowChildError,
  isCompiledBunWorkflowRuntime,
  resolveRelayflowsCliEntrypoint,
  workflowNodeExecutable,
} from './workflow-runtime.js';

const compiled = {
  env: { ...process.env },
  argv: ['bun', '/$bunfs/root/cli/index.js'],
  execPath: '/tmp/agent-relay',
  cliScript: '/$bunfs/root/cli/index.js',
};

describe('workflow runtime selection', () => {
  it('detects the compiled Bun argv signature', () => {
    expect(isCompiledBunWorkflowRuntime(compiled)).toBe(true);
    expect(
      isCompiledBunWorkflowRuntime({
        ...compiled,
        argv: ['node', '/$bunfs/root/cli/index.js'],
      })
    ).toBe(false);
    expect(
      isCompiledBunWorkflowRuntime({
        ...compiled,
        cliScript: '/workspace/packages/cli/dist/cli/index.js',
      })
    ).toBe(false);
  });

  it('uses the configured Node executable for compiled Bun and process.execPath otherwise', () => {
    expect(workflowNodeExecutable(compiled)).toBe('node');
    expect(workflowNodeExecutable({ ...compiled, env: { AGENT_RELAY_NODE: ' /opt/node/bin/node ' } })).toBe(
      '/opt/node/bin/node'
    );
    expect(
      workflowNodeExecutable({
        env: {},
        argv: ['node', '/workspace/cli.js'],
        execPath: '/opt/node/bin/node',
        cliScript: '/workspace/cli.js',
      })
    ).toBe('/opt/node/bin/node');
  });

  it('keeps normal Node resolution anchored to the installed CLI package', async () => {
    await expect(
      resolveRelayflowsCliEntrypoint('/tmp/workflow-without-node-modules.yaml', {
        env: {},
        argv: ['node', '/repo/packages/cli/dist/cli/index.js'],
        execPath: '/opt/node/bin/node',
        cliScript: '/repo/packages/cli/dist/cli/index.js',
      })
    ).resolves.toMatch(/node_modules[\\/]@relayflows[\\/]cli/);
  });

  it('resolves project dependencies from the workflow path', async () => {
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(
        Object.assign(new Error('Cannot find module @relayflows/cli'), { code: 'MODULE_NOT_FOUND' }),
        '',
        ''
      );
    });
    await expect(
      resolveRelayflowsCliEntrypoint('/tmp/no-workflow.yaml', {
        ...compiled,
        execFile: execFile as never,
      })
    ).rejects.toThrow(
      /Cannot resolve @relayflows\/cli from \/tmp\/no-workflow\.yaml.*Install @relayflows\/cli.*Cause:/s
    );
  });

  it('asks Node to resolve from the real workflow directory in compiled mode', async () => {
    const execFile = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(null, '/project/node_modules/@relayflows/cli/dist/cli.js\n', '');
      }
    );
    const entrypoint = await resolveRelayflowsCliEntrypoint('/project/workflow.yaml', {
      ...compiled,
      execFile: execFile as never,
    });

    expect(entrypoint).toBe('/project/node_modules/@relayflows/cli/dist/cli.js');
    expect(execFile).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['@relayflows/cli', '/project']),
      expect.objectContaining({ cwd: '/project' }),
      expect.any(Function)
    );
  });

  it('makes missing executable failures actionable', () => {
    expect(describeWorkflowChildError(new Error('spawn node ENOENT'), 'node').message).toMatch(
      /Node\.js executable.*AGENT_RELAY_NODE/
    );
  });
});
