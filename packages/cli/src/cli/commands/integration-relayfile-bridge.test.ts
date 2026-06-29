import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: childProcessMock.spawn };
});

import { defaultRelayfileBridge } from './integration.js';

/** A fake child process that emits `stdout` then closes with `code`. */
function fakeChild(stdout: string, code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

afterEach(() => {
  childProcessMock.spawn.mockReset();
});

describe('defaultRelayfileBridge.listBindings', () => {
  it('lists bindings via `bind --list` without the unsupported `--json` flag', async () => {
    // relayfile's `integration bind` defines no `--json` flag and `--list`
    // already emits JSON; passing `--json` errors with
    // "flag provided but not defined: -json".
    childProcessMock.spawn.mockReturnValue(fakeChild('[]'));

    const bindings = await defaultRelayfileBridge().listBindings();

    expect(bindings).toEqual([]);
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'relayfile',
      ['integration', 'bind', '--list'],
      expect.anything()
    );
    const [, argv] = childProcessMock.spawn.mock.calls[0]!;
    expect(argv).not.toContain('--json');
  });

  it('normalizes relayfile `pathGlob` to `resource`', async () => {
    childProcessMock.spawn.mockReturnValue(
      fakeChild(
        JSON.stringify([
          {
            provider: 'slack',
            pathGlob: '/slack/channels/C0/**',
            channel: 'general',
            webhookId: 'wh1',
            subscriptionId: 'sub1',
          },
        ])
      )
    );

    const bindings = await defaultRelayfileBridge().listBindings();

    expect(bindings).toEqual([
      {
        provider: 'slack',
        resource: '/slack/channels/C0/**',
        channel: 'general',
        webhookId: 'wh1',
        subscriptionId: 'sub1',
      },
    ]);
  });
});
