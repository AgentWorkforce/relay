import {
  RELAY_CLI_CONTRACT_VERSION,
  type RelayCliCommandSpec,
  type RelayCliSurface,
} from './types.js';

/** Exit code a surface returns when it cannot route the given argv. */
export const RELAY_CLI_EXIT_UNKNOWN_COMMAND = 2;

/** A conformance problem found in a surface. */
export interface RelayCliSurfaceViolation {
  /** Dotted path to the offending node, e.g. `commands.run.options[0]`. */
  path: string;
  message: string;
}

const FLAG_PATTERN = /^(-[A-Za-z0-9], )?--[a-z0-9][a-z0-9-]*( [<[][^>\]]+[>\]])?$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function checkCommand(
  command: RelayCliCommandSpec,
  path: string,
  seen: Set<string>,
  violations: RelayCliSurfaceViolation[]
): void {
  if (!NAME_PATTERN.test(command.name)) {
    violations.push({
      path: `${path}.name`,
      message: `command name ${JSON.stringify(command.name)} must be lowercase kebab-case`,
    });
  }
  if (seen.has(command.name)) {
    violations.push({ path: `${path}.name`, message: `duplicate command name ${command.name}` });
  }
  seen.add(command.name);

  if (!command.description.trim()) {
    violations.push({ path: `${path}.description`, message: 'description must not be empty' });
  }

  let sawOptional = false;
  command.args?.forEach((arg, index) => {
    // Commander cannot express a required positional after an optional one, and
    // a variadic must be last or it swallows its successors.
    if (arg.required && sawOptional) {
      violations.push({
        path: `${path}.args[${index}]`,
        message: `required arg ${arg.name} cannot follow an optional arg`,
      });
    }
    if (!arg.required) sawOptional = true;
    if (arg.variadic && index !== (command.args?.length ?? 0) - 1) {
      violations.push({
        path: `${path}.args[${index}]`,
        message: `variadic arg ${arg.name} must be the last positional`,
      });
    }
  });

  const flags = new Set<string>();
  command.options?.forEach((option, index) => {
    if (!FLAG_PATTERN.test(option.flags)) {
      violations.push({
        path: `${path}.options[${index}]`,
        message: `flags ${JSON.stringify(option.flags)} is not a commander flag string`,
      });
    }
    const long = option.flags.match(/--[a-z0-9][a-z0-9-]*/)?.[0];
    if (long && flags.has(long)) {
      violations.push({ path: `${path}.options[${index}]`, message: `duplicate flag ${long}` });
    }
    if (long) flags.add(long);
  });

  const childNames = new Set<string>();
  command.subcommands?.forEach((child) => {
    checkCommand(child, `${path}.${child.name}`, childNames, violations);
  });
}

/**
 * Check a surface against the structural rules in the contract.
 *
 * This validates the declared shape only. Each product repo pairs it with a
 * drift test proving `commands` and `run` dispatch the same tree.
 *
 * @param surface - The surface to check.
 * @returns Every violation found; empty when the surface conforms.
 */
export function findSurfaceViolations(surface: RelayCliSurface): RelayCliSurfaceViolation[] {
  const violations: RelayCliSurfaceViolation[] = [];

  if (!NAME_PATTERN.test(surface.id)) {
    violations.push({ path: 'id', message: `surface id ${JSON.stringify(surface.id)} must be kebab-case` });
  }
  if (!surface.version.trim()) {
    violations.push({ path: 'version', message: 'version must not be empty' });
  }
  if (surface.contract !== RELAY_CLI_CONTRACT_VERSION) {
    violations.push({
      path: 'contract',
      message: `contract ${String(surface.contract)} is not supported (expected ${RELAY_CLI_CONTRACT_VERSION})`,
    });
  }
  if (surface.commands.length === 0) {
    violations.push({ path: 'commands', message: 'surface declares no commands' });
  }

  const seen = new Set<string>();
  surface.commands.forEach((command) => {
    checkCommand(command, `commands.${command.name}`, seen, violations);
  });

  return violations;
}

/**
 * Throw unless the surface conforms to the contract.
 *
 * @param surface - The surface to check.
 * @throws When any violation is found; the message lists all of them.
 */
export function assertSurfaceConforms(surface: RelayCliSurface): void {
  const violations = findSurfaceViolations(surface);
  if (violations.length === 0) return;
  const detail = violations.map((violation) => `  ${violation.path}: ${violation.message}`).join('\n');
  throw new Error(`CLI surface ${surface.id} violates contract v${RELAY_CLI_CONTRACT_VERSION}:\n${detail}`);
}

/**
 * Walk every command in a surface, deepest-last, with its invocation path.
 *
 * @param commands - The command tree to walk.
 * @returns Each command paired with the argv path that reaches it.
 */
export function* walkCommands(
  commands: readonly RelayCliCommandSpec[],
  prefix: readonly string[] = []
): Generator<{ path: readonly string[]; command: RelayCliCommandSpec }> {
  for (const command of commands) {
    const path = [...prefix, command.name];
    yield { path, command };
    if (command.subcommands) yield* walkCommands(command.subcommands, path);
  }
}
