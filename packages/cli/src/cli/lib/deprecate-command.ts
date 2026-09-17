/**
 * Mark existing commander commands as deprecated without changing what they do.
 *
 * Used for the v1 relayflows commands under `agent-relay cloud`, which are
 * superseded by the v2 `agent-relay flows` surface. The agreed behaviour is
 * "keep working, warn, hide": scripts that call them today keep passing, the
 * operator is told what to move to, and new users never discover v1 from
 * `--help`.
 *
 * Hiding goes through commander's public `configureHelp({ visibleCommands })`
 * rather than the private `_hidden` field, so a commander upgrade cannot
 * silently un-hide the v1 surface.
 */

import { Help, type Command } from 'commander';

/** Where a deprecated command's callers should go instead. */
export interface DeprecationNotice {
  /** Replacement invocation, e.g. `agent-relay flows run`. */
  replacement: string;
  /** Version the deprecation took effect. */
  since: string;
  /**
   * Extra guidance appended to the warning.
   *
   * Set this when the replacement is not a drop-in — a v1 command whose v2
   * equivalent takes different arguments needs to say so, or the pointer is
   * worse than no pointer.
   */
  note?: string;
}

/** Injectable warning sink; defaults to the real stderr. */
export interface DeprecationDependencies {
  warn: (message: string) => void;
}

/**
 * Render the stderr notice for a deprecated command.
 *
 * @param invocation - How the user reached the command, e.g. `agent-relay cloud run`.
 * @param notice - Replacement and guidance.
 * @returns The warning text, newline-terminated.
 */
export function formatDeprecationWarning(invocation: string, notice: DeprecationNotice): string {
  const lines = [
    `warning: \`${invocation}\` is deprecated since ${notice.since} and will be removed in a future release.`,
    `         Use \`${notice.replacement}\` instead.`,
  ];
  if (notice.note) lines.push(`         ${notice.note}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Attach a deprecation warning to one command and hide it from its parent's help.
 *
 * The command's action is untouched: it still runs, and still returns whatever
 * it returned before.
 *
 * @param command - The command to deprecate. Must already be attached to a parent.
 * @param notice - Replacement and guidance.
 * @param overrides - Test seam for the warning sink.
 * @throws When the command has no parent, since there is then no help to hide it from.
 */
export function deprecateCommand(
  command: Command,
  notice: DeprecationNotice,
  overrides: Partial<DeprecationDependencies> = {}
): void {
  const warn = overrides.warn ?? ((message: string) => process.stderr.write(message));
  const parent = command.parent;
  if (!parent) {
    throw new Error(`cannot deprecate '${command.name()}': it is not attached to a parent command`);
  }

  // Keep the text accurate for anyone who reaches help another way (`--help`
  // on the command itself still prints its own description).
  command.description(`${command.description()} (deprecated — use \`${notice.replacement}\`)`);

  command.hook('preAction', () => {
    warn(formatDeprecationWarning(invocationPath(command), notice));
  });

  hideFromParentHelp(parent, command.name());
}

/** Build the full invocation path for a command, e.g. `agent-relay cloud run`. */
function invocationPath(command: Command): string {
  const names: string[] = [];
  let cursor: Command | null = command;
  while (cursor) {
    names.unshift(cursor.name());
    cursor = cursor.parent;
  }
  return names.join(' ');
}

/** Command names hidden from each parent's help, keyed by the parent command. */
const hiddenByParent = new WeakMap<Command, Set<string>>();

/**
 * Hide one subcommand name from a parent's help listing.
 *
 * Idempotent, and safe to call for several children of the same parent: the
 * help override is installed once and consults a growing name set.
 */
function hideFromParentHelp(parent: Command, name: string): void {
  const existing = hiddenByParent.get(parent);
  if (existing) {
    existing.add(name);
    return;
  }

  const hidden = new Set([name]);
  hiddenByParent.set(parent, hidden);

  // Delegate to commander's own visibility rules, then subtract. Reimplementing
  // the filter would drop its handling of the built-in help command.
  const base = new Help();
  parent.configureHelp({
    visibleCommands: (cmd: Command) =>
      base.visibleCommands(cmd).filter((child) => !hidden.has(child.name())),
  });
}

/**
 * Read back the names hidden from a parent's help.
 *
 * Exported for tests; production code has no reason to ask.
 */
export function hiddenCommandNames(parent: Command): readonly string[] {
  return [...(hiddenByParent.get(parent) ?? [])];
}
