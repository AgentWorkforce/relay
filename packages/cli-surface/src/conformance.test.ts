import { describe, expect, it } from 'vitest';

import { assertSurfaceConforms, findSurfaceViolations, walkCommands } from './conformance.js';
import { RELAY_CLI_CONTRACT_VERSION, type RelayCliSurface } from './types.js';

function surface(overrides: Partial<RelayCliSurface> = {}): RelayCliSurface {
  return {
    id: 'relayfile',
    version: '1.0.0',
    contract: RELAY_CLI_CONTRACT_VERSION,
    commands: [{ name: 'ls', description: 'List files' }],
    run: async () => 0,
    ...overrides,
  };
}

describe('findSurfaceViolations', () => {
  it('accepts a conforming surface', () => {
    expect(findSurfaceViolations(surface())).toEqual([]);
  });

  it('rejects a surface built against another contract revision', () => {
    // A product package pinned to an older @agent-relay/cli-surface would
    // otherwise mount and then misbehave at dispatch time.
    const violations = findSurfaceViolations(surface({ contract: 2 as never }));
    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toBe('contract');
  });

  it('rejects a non-kebab-case command name', () => {
    const violations = findSurfaceViolations(
      surface({ commands: [{ name: 'listFiles', description: 'List files' }] })
    );
    expect(violations[0]!.path).toBe('commands.listFiles.name');
  });

  it('rejects a duplicate command name at the same level', () => {
    const violations = findSurfaceViolations(
      surface({
        commands: [
          { name: 'ls', description: 'List files' },
          { name: 'ls', description: 'List files again' },
        ],
      })
    );
    expect(violations.map((violation) => violation.message)).toContain('duplicate command name ls');
  });

  it('rejects an empty description', () => {
    const violations = findSurfaceViolations(
      surface({ commands: [{ name: 'ls', description: '   ' }] })
    );
    expect(violations[0]!.path).toBe('commands.ls.description');
  });

  it('rejects a required positional after an optional one', () => {
    // Commander cannot express this ordering, so the mount would throw at
    // registration time rather than when the command runs.
    const violations = findSurfaceViolations(
      surface({
        commands: [
          {
            name: 'ls',
            description: 'List files',
            args: [
              { name: 'path', description: 'Path', required: false },
              { name: 'glob', description: 'Glob', required: true },
            ],
          },
        ],
      })
    );
    expect(violations[0]!.message).toContain('cannot follow an optional arg');
  });

  it('rejects a variadic positional that is not last', () => {
    const violations = findSurfaceViolations(
      surface({
        commands: [
          {
            name: 'ls',
            description: 'List files',
            args: [
              { name: 'paths', description: 'Paths', required: true, variadic: true },
              { name: 'glob', description: 'Glob', required: true },
            ],
          },
        ],
      })
    );
    expect(violations[0]!.message).toContain('must be the last positional');
  });

  it('rejects a malformed flag string', () => {
    const violations = findSurfaceViolations(
      surface({
        commands: [{ name: 'ls', description: 'List files', options: [{ flags: 'json', description: 'JSON' }] }],
      })
    );
    expect(violations[0]!.message).toContain('is not a commander flag string');
  });

  it('rejects a duplicate flag on one command', () => {
    const violations = findSurfaceViolations(
      surface({
        commands: [
          {
            name: 'ls',
            description: 'List files',
            options: [
              { flags: '--json', description: 'JSON' },
              { flags: '-j, --json', description: 'JSON again' },
            ],
          },
        ],
      })
    );
    expect(violations.map((violation) => violation.message)).toContain('duplicate flag --json');
  });

  it('reports violations nested inside subcommands', () => {
    const violations = findSurfaceViolations(
      surface({
        commands: [
          {
            name: 'session',
            description: 'Sessions',
            subcommands: [{ name: 'Show', description: 'Show one' }],
          },
        ],
      })
    );
    expect(violations[0]!.path).toBe('commands.session.Show.name');
  });

  it('rejects a surface with no commands', () => {
    expect(findSurfaceViolations(surface({ commands: [] }))[0]!.path).toBe('commands');
  });
});

describe('assertSurfaceConforms', () => {
  it('lists every violation in the thrown message', () => {
    expect(() =>
      assertSurfaceConforms(
        surface({
          id: 'Relay File',
          commands: [{ name: 'ls', description: '' }],
        })
      )
    ).toThrow(/id: .*kebab-case[\s\S]*description must not be empty/);
  });

  it('stays silent on a conforming surface', () => {
    expect(() => assertSurfaceConforms(surface())).not.toThrow();
  });
});

describe('walkCommands', () => {
  it('yields each command with the argv path that reaches it', () => {
    const walked = [
      ...walkCommands([
        {
          name: 'session',
          description: 'Sessions',
          subcommands: [
            { name: 'show', description: 'Show one' },
            {
              name: 'export',
              description: 'Export',
              subcommands: [{ name: 'json', description: 'As JSON' }],
            },
          ],
        },
      ]),
    ];
    expect(walked.map((entry) => entry.path.join(' '))).toEqual([
      'session',
      'session show',
      'session export',
      'session export json',
    ]);
  });
});
