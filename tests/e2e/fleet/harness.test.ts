import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FleetNode } from './harness.js';

const identityMocks = vi.hoisted(() => ({ read: vi.fn(), matches: vi.fn(), remove: vi.fn() }));
vi.mock('../../../packages/cli/src/cli/lib/broker-process-identity.js', () => ({
  readBrokerIdentities: identityMocks.read,
  matchesBrokerIdentity: identityMocks.matches,
  removeBrokerIdentity: identityMocks.remove,
}));

let directory: string;
beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(path.join(tmpdir(), 'relay-fleet-stop-'));
  identityMocks.read.mockReset().mockReturnValue([]);
  identityMocks.matches.mockReset().mockResolvedValue(false);
  identityMocks.remove.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const node = new FleetNode({
    name: 'node-a',
    nodeId: 'fixture',
    nodeFile: 'unused',
    nodeToken: 'fixture',
    workspaceKey: 'fixture',
    engineBaseUrl: 'http://localhost',
    brokerBinary: 'unused',
    tmpRoot: directory,
  });
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
  });
  Object.assign(node, { child });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  return { node, child, kill };
}

it('crashes only a reverified named broker and retires it only after observed exit', async () => {
  const { node, child, kill } = fixture();
  const identity = { pid: 81234, brokerName: 'node-a' };
  identityMocks.read.mockReturnValue([{ pid: 81235, brokerName: 'peer' }, identity]);
  identityMocks.matches.mockResolvedValue(true);
  let exited = false;
  kill.mockImplementation((_pid, signal) => {
    if (signal === 0 && exited) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  child.kill.mockImplementation(() => {
    child.signalCode = 'SIGKILL';
    child.emit('exit', null);
  });
  const stopped = node.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(identityMocks.matches).toHaveBeenCalledTimes(1);
  expect(identityMocks.matches).toHaveBeenCalledWith(identity, expect.anything(), expect.anything());
  expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[81234, 'SIGKILL']]);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(identityMocks.remove).not.toHaveBeenCalled();
  exited = true;
  await vi.runAllTimersAsync();
  await stopped;
  expect(identityMocks.remove).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    identity,
    expect.anything()
  );
  expect(child.listenerCount('exit')).toBe(0);
});

it.each([null, [], [{ pid: 81234, brokerName: 'node-a' }]])(
  'never signals a connection-only or unverifiable PID: %j',
  async (records) => {
    const { node, child, kill } = fixture();
    identityMocks.read.mockReturnValue(records);
    writeFileSync(
      path.join(node.projectDir, '.agentworkforce/relay/connection.json'),
      JSON.stringify({ pid: 81234 })
    );
    child.kill.mockImplementation(() => {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    });
    const stopped = node.stop();
    await vi.runAllTimersAsync();
    await stopped;
    expect(kill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  }
);

it('bounds the supervisor cleanup wait and only kills its directly owned handle', async () => {
  const { node, child, kill } = fixture();
  const stopped = node.stop();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  await vi.runAllTimersAsync();
  await stopped;
  expect(kill).not.toHaveBeenCalled();
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  expect(child.listenerCount('exit')).toBe(0);
});

it.each(['EPERM', 'still-running'])(
  'retains the record when post-kill exit is unobserved: %s',
  async (outcome) => {
    const { node, child, kill } = fixture();
    identityMocks.read.mockReturnValue([{ pid: 81234, brokerName: 'node-a' }]);
    identityMocks.matches.mockResolvedValue(true);
    child.kill.mockImplementation(() => {
      child.signalCode = 'SIGKILL';
      child.emit('exit', null);
    });
    kill.mockImplementation((_pid, signal) => {
      if (signal === 0 && outcome === 'EPERM') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return true;
    });
    const rejected = expect(node.stop()).rejects.toThrow('verified fixture broker exit');
    await vi.runAllTimersAsync();
    await rejected;
    expect(identityMocks.remove).not.toHaveBeenCalled();
  }
);
