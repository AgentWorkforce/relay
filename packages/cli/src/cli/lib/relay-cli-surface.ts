/**
 * The single generic mount point for Relay product CLIs.
 *
 * `agent-relay file`, `agent-relay flows`, and `agent-relay sessions` are all
 * this module. Each product repo (relayfile, flows, relayhistory) ships a
 * {@link RelayCliSurface} describing and dispatching its own commands; this
 * host renders help from the declared tree and forwards everything else to the
 * product verbatim. No product command is reimplemented here — if a command
 * needs to change, it changes in the product repo.
 *
 * Two deliberate choices:
 *
 * - **Argv is forwarded untouched.** Commander parses only far enough to find
 *   the group, then hands the remaining tokens straight to `surface.run`. A
 *   re-serialized option list would silently drop product flags the host has
 *   never heard of.
 * - **Help is rendered from the spec, not forwarded.** Asking the product to
 *   print its own help yields its own program name (`relayfile ls …`), which is
 *   wrong once mounted. Rendering from `commands` keeps `agent-relay file ls`
 *   in the usage line and makes every product's help look the same.
 */

import type { Command } from 'commander';

import type {
  RelayCliCommandSpec,
  RelayCliIo,
  RelayCliSurface,
} from '@agent-relay/cli-surface';

import { describeError } from './describe-error.js';
import { defaultExit } from './exit.js';

/** Exit code used when the argv names no command in the surface. */
const EXIT_UNKNOWN_COMMAND = 2;

/** Injectable seams; the defaults are the real process. */
export interface RelayCliSurfaceDependencies {
  io: RelayCliIo;
  exit: (code: number) => never;
}

export interface MountSurfaceOptions {
  /** Group name under `agent-relay`, e.g. `file`. */
  as: string;
  /** One-line description for `agent-relay --help`. */
  description: string;
  /**
   * Import and construct the surface.
   *
   * Called only once the group is actually invoked. Product SDKs are heavy
   * (the relayfile SDK resolves a Go binary, the flows SDK pulls a runtime),
   * so importing them eagerly would tax every `agent-relay` invocation
   * including `--help`.
   */
  load: () => Promise<RelayCliSurface>;
  /**
   * Extra group names that reach the same surface, hidden from help.
   *
   * Used to keep `agent-relay session …` working after it was absorbed into
   * `agent-relay sessions`.
   */
  hiddenAliases?: readonly string[];
}

function withDefaults(overrides: Partial<RelayCliSurfaceDependencies>): RelayCliSurfaceDependencies {
  return {
    io: overrides.io ?? {
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
    },
    exit: overrides.exit ?? defaultExit,
  };
}

/** True when the token asks for help rather than naming a command. */
function isHelpFlag(token: string): boolean {
  return token === '--help' || token === '-h' || token === 'help';
}

/**
 * Walk `argv` down the spec tree as far as it matches.
 *
 * @returns The deepest matched command (undefined at the group root), the path
 *   taken, and the first token that did not match a subcommand.
 */
export function resolveSpecPath(
  commands: readonly RelayCliCommandSpec[],
  argv: readonly string[]
): {
  command: RelayCliCommandSpec | undefined;
  path: readonly string[];
  /** Tokens left once matching stopped, including the one that failed to match. */
  rest: readonly string[];
} {
  let level: readonly RelayCliCommandSpec[] = commands;
  let command: RelayCliCommandSpec | undefined;
  const path: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    // Stop at the first flag: everything after it belongs to the product.
    if (token.startsWith('-')) return { command, path, rest: argv.slice(index) };
    const match = level.find(
      (candidate) => candidate.name === token || candidate.aliases?.includes(token)
    );
    if (!match) return { command, path, rest: argv.slice(index) };
    command = match;
    path.push(match.name);
    level = match.subcommands ?? [];
  }

  return { command, path, rest: [] };
}

function renderUsage(groupPath: string, command: RelayCliCommandSpec | undefined): string {
  const parts = [groupPath];
  if (command?.subcommands?.length) parts.push('<command>');
  for (const arg of command?.args ?? []) {
    const name = arg.variadic ? `${arg.name}...` : arg.name;
    parts.push(arg.required ? `<${name}>` : `[${name}]`);
  }
  if (command?.options?.length || !command) parts.push('[options]');
  return `Usage: ${parts.join(' ')}`;
}

function renderColumns(rows: readonly (readonly [string, string])[], indent = '  '): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`);
}

/**
 * Render help for one node of a product command tree.
 *
 * @param groupPath - How the user reached here, e.g. `agent-relay file ls`.
 * @param command - The resolved spec node, or undefined for the group root.
 * @param roots - The surface's top-level commands, used at the group root.
 * @returns The help text, newline-terminated.
 */
export function renderSurfaceHelp(
  groupPath: string,
  command: RelayCliCommandSpec | undefined,
  roots: readonly RelayCliCommandSpec[]
): string {
  const lines: string[] = [renderUsage(groupPath, command), ''];

  if (command?.description) lines.push(command.description, '');
  if (command?.deprecated) {
    lines.push(`Deprecated. Use \`${command.deprecated.replacement}\` instead.`, '');
  }

  const args = command?.args ?? [];
  if (args.length > 0) {
    lines.push('Arguments:');
    lines.push(
      ...renderColumns(
        args.map((arg) => [arg.variadic ? `${arg.name}...` : arg.name, arg.description] as const)
      )
    );
    lines.push('');
  }

  const options = command?.options ?? [];
  if (options.length > 0) {
    lines.push('Options:');
    lines.push(
      ...renderColumns(
        options.map(
          (option) =>
            [
              option.flags,
              option.defaultValue === undefined
                ? option.description
                : `${option.description} (default: ${JSON.stringify(option.defaultValue)})`,
            ] as const
        )
      )
    );
    lines.push('');
  }

  const children = (command?.subcommands ?? roots).filter((child) => !child.hidden);
  if (children.length > 0) {
    lines.push('Commands:');
    lines.push(
      ...renderColumns(
        children.map(
          (child) =>
            [
              child.name,
              child.deprecated ? `${child.description} (deprecated)` : child.description,
            ] as const
        )
      )
    );
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Run one invocation against a loaded surface.
 *
 * Exported for tests and for the hidden-alias path; `mountRelayCliSurface` is
 * the normal entry point.
 *
 * @param surface - The product surface.
 * @param groupPath - Display path for help and notices, e.g. `agent-relay file`.
 * @param argv - Tokens after the group name.
 * @param deps - Output sink and exit function.
 * @returns The exit code the host should use.
 */
export async function runSurface(
  surface: RelayCliSurface,
  groupPath: string,
  argv: readonly string[],
  deps: RelayCliSurfaceDependencies
): Promise<number> {
  const resolved = resolveSpecPath(surface.commands, argv);

  const wantsHelp = argv.length === 0 || argv.some(isHelpFlag);
  if (wantsHelp) {
    // `--help` after a partially-matched path still documents the deepest node
    // we recognised, which is what the user was asking about.
    deps.io.stdout(
      renderSurfaceHelp([groupPath, ...resolved.path].join(' '), resolved.command, surface.commands)
    );
    return 0;
  }

  if (!resolved.command) {
    const unknown = resolved.rest[0] ?? argv[0] ?? '';
    const available = surface.commands
      .filter((command) => !command.hidden)
      .map((command) => command.name)
      .join(', ');
    deps.io.stderr(
      `error: unknown command '${unknown}' for \`${groupPath}\`\n` +
        `Available commands: ${available}\n` +
        `Run \`${groupPath} --help\` for usage.\n`
    );
    return EXIT_UNKNOWN_COMMAND;
  }

  if (resolved.command.deprecated) {
    const { replacement, since } = resolved.command.deprecated;
    deps.io.stderr(
      `warning: \`${[groupPath, ...resolved.path].join(' ')}\` is deprecated` +
        `${since ? ` since ${since}` : ''}. Use \`${replacement}\` instead.\n`
    );
  }

  try {
    return await surface.run(argv, deps.io);
  } catch (error) {
    // A product throwing instead of returning a code is a contract violation,
    // but it must not surface as an unhandled rejection from the host.
    deps.io.stderr(`${describeError(error)}\n`);
    return 1;
  }
}

/**
 * Mount a product CLI as a group on the `agent-relay` program.
 *
 * @param program - The root commander program.
 * @param options - Group name, description, and the lazy surface loader.
 * @param overrides - Test seams for io and exit.
 */
export function mountRelayCliSurface(
  program: Command,
  options: MountSurfaceOptions,
  overrides: Partial<RelayCliSurfaceDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  const attach = (name: string, hidden: boolean): void => {
    program
      .command(name, { hidden })
      .description(options.description)
      // The product owns its flags; commander must not reject or consume them.
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      // Without this, `agent-relay file --json` is parsed as a root-level flag.
      .enablePositionalOptions()
      .passThroughOptions()
      // Help is rendered from the surface spec, so commander must not intercept.
      .helpOption(false)
      .argument('[args...]', `Arguments passed through to ${options.as}`)
      .action(async (args: string[]) => {
        const surface = await options.load();
        const code = await runSurface(surface, `agent-relay ${options.as}`, args, deps);
        if (code !== 0) deps.exit(code);
      });
  };

  attach(options.as, false);
  for (const alias of options.hiddenAliases ?? []) attach(alias, true);
}
