import { assertSurfaceConforms } from './conformance.js';
import {
  RELAY_CLI_CONTRACT_VERSION,
  type RelayCliCommandSpec,
  type RelayCliIo,
  type RelayCliSurface,
} from './types.js';

/** Inputs for {@link composeSurfaces}. */
export interface ComposeSurfacesOptions {
  /** Identifier for the combined surface, e.g. `relayhistory`. */
  id: string;
  /** Version reported for the combined surface. */
  version: string;
  /**
   * Surfaces to merge, in precedence order for error messages.
   *
   * Their top-level command names must be disjoint: two parts claiming the same
   * name would make dispatch ambiguous, and silently picking one would route
   * some invocations to the wrong implementation.
   */
  parts: readonly RelayCliSurface[];
}

/**
 * Merge several surfaces into one command tree.
 *
 * `agent-relay sessions` spans local history (`ai-hist`), a cloud client, and
 * Relay's own session replay. Presenting those as three mounted groups would
 * leak our package boundaries into the user's command line; composing them
 * keeps one coherent tree while each half stays owned by its repo.
 *
 * Dispatch routes on the first token: the part that declared that top-level
 * command receives the full argv unchanged, so a part cannot tell whether it
 * was composed or mounted directly.
 *
 * @param options - Combined identity and the parts to merge.
 * @returns A surface whose commands are the concatenation of its parts'.
 * @throws When two parts claim the same top-level name (as a command or an
 *   alias), or when a part does not itself conform to the contract.
 */
export function composeSurfaces(options: ComposeSurfacesOptions): RelayCliSurface {
  /** How a top-level name was claimed, so collisions can be described accurately. */
  interface Claim {
    surface: RelayCliSurface;
    kind: 'command' | 'alias';
  }

  const owners = new Map<string, Claim>();
  const commands: RelayCliCommandSpec[] = [];

  const claim = (name: string, kind: Claim['kind'], part: RelayCliSurface): void => {
    const existing = owners.get(name);
    if (existing) {
      const describe = (c: Claim): string => `${c.kind} '${name}' from '${c.surface.id}'`;
      throw new Error(
        `cannot compose surface '${options.id}': ${describe({ surface: part, kind })} ` +
          `collides with ${describe(existing)}`
      );
    }
    owners.set(name, { surface: part, kind });
  };

  for (const part of options.parts) {
    // Catch a malformed part here rather than at first invocation: a composed
    // surface is usually built at mount time, so this fails fast and names the
    // offending part.
    assertSurfaceConforms(part);

    for (const command of part.commands) {
      claim(command.name, 'command', part);
      for (const alias of command.aliases ?? []) claim(alias, 'alias', part);
      commands.push(command);
    }
  }

  return {
    id: options.id,
    version: options.version,
    contract: RELAY_CLI_CONTRACT_VERSION,
    commands,
    async run(argv: readonly string[], io: RelayCliIo): Promise<number> {
      const first = argv[0];
      const owner = first === undefined ? undefined : owners.get(first)?.surface;
      if (!owner) {
        // The host renders help and unknown-command errors from `commands`, so
        // reaching here means it dispatched something the spec does not cover.
        io.stderr(`error: '${first ?? ''}' is not a command of ${options.id}\n`);
        return 2;
      }
      return owner.run(argv, io);
    },
  };
}
