import { describe, expect, it, vi } from 'vitest';

import { composeSurfaces } from './compose.js';
import { type RelayCliIo, type RelayCliSurface } from './types.js';

function makeIo(): RelayCliIo & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    stdout(chunk: string) {
      sink.out += chunk;
    },
    stderr(chunk: string) {
      sink.err += chunk;
    },
  };
  return sink;
}

function part(id: string, names: readonly string[], run = vi.fn(async () => 0)): RelayCliSurface {
  return {
    id,
    version: '1.0.0',
    contract: 1,
    commands: names.map((name) => ({ name, description: `${name} from ${id}` })),
    run,
  };
}

describe('composeSurfaces', () => {
  it('concatenates the parts command trees', () => {
    const composed = composeSurfaces({
      id: 'relayhistory',
      version: '0.17.0',
      parts: [part('local', ['list', 'show']), part('cloud', ['recall', 'export'])],
    });

    expect(composed.commands.map((command) => command.name)).toEqual([
      'list',
      'show',
      'recall',
      'export',
    ]);
  });

  it('routes each command to the part that declared it, with argv intact', async () => {
    const localRun = vi.fn(async () => 0);
    const cloudRun = vi.fn(async () => 0);
    const io = makeIo();
    const composed = composeSurfaces({
      id: 'relayhistory',
      version: '0.17.0',
      parts: [part('local', ['list'], localRun), part('cloud', ['recall'], cloudRun)],
    });

    await composed.run(['recall', 'topic', '--limit', '5'], io);

    expect(cloudRun).toHaveBeenCalledWith(['recall', 'topic', '--limit', '5'], io);
    expect(localRun).not.toHaveBeenCalled();
  });

  it('returns the owning part exit code', async () => {
    const composed = composeSurfaces({
      id: 'relayhistory',
      version: '0.17.0',
      parts: [part('local', ['list'], vi.fn(async () => 7))],
    });

    await expect(composed.run(['list'], makeIo())).resolves.toBe(7);
  });

  it('routes an alias to its declaring part', async () => {
    const run = vi.fn(async () => 0);
    const composed = composeSurfaces({
      id: 'relayhistory',
      version: '0.17.0',
      parts: [
        {
          id: 'local',
          version: '1.0.0',
          contract: 1,
          commands: [{ name: 'list', description: 'List sessions', aliases: ['ls'] }],
          run,
        },
      ],
    });

    await composed.run(['ls'], makeIo());

    expect(run).toHaveBeenCalledWith(['ls'], expect.anything());
  });

  it('refuses to compose parts that claim the same command name', () => {
    // Silently picking one would route some invocations to the wrong repo's
    // implementation, which is exactly the class of bug composition invites.
    expect(() =>
      composeSurfaces({
        id: 'relayhistory',
        version: '0.17.0',
        parts: [part('local', ['export']), part('cloud', ['export'])],
      })
    ).toThrow(/command 'export' from 'cloud' collides with command 'export' from 'local'/);
  });

  it('refuses when one part alias collides with another part command', () => {
    expect(() =>
      composeSurfaces({
        id: 'relayhistory',
        version: '0.17.0',
        parts: [
          {
            id: 'local',
            version: '1.0.0',
            contract: 1,
            commands: [{ name: 'list', description: 'List', aliases: ['recall'] }],
            run: vi.fn(async () => 0),
          },
          part('cloud', ['recall']),
        ],
      })
    ).toThrow(/command 'recall' from 'cloud' collides with alias 'recall' from 'local'/);
  });

  it('rejects a non-conforming part at composition time', () => {
    expect(() =>
      composeSurfaces({
        id: 'relayhistory',
        version: '0.17.0',
        parts: [
          {
            id: 'local',
            version: '1.0.0',
            contract: 1,
            commands: [{ name: 'BadName', description: 'Nope' }],
            run: vi.fn(async () => 0),
          },
        ],
      })
    ).toThrow(/violates contract/);
  });

  it('reports an unroutable token rather than throwing', async () => {
    const io = makeIo();
    const composed = composeSurfaces({
      id: 'relayhistory',
      version: '0.17.0',
      parts: [part('local', ['list'])],
    });

    await expect(composed.run(['bogus'], io)).resolves.toBe(2);
    expect(io.err).toContain("'bogus' is not a command of relayhistory");
  });
});
