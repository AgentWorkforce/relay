/**
 * Deprecate the relayflows v1 surface under `agent-relay cloud`.
 *
 * Scope is deliberately narrow. Only two commands are actually v1-only:
 * `schedule` and `schedules` reject `--relayflow-version v2` outright, so they
 * cannot serve a v2 run. The rest of the group — `status`, `logs`, `sync`,
 * `cancel` — take a run id and query the Cloud API for whichever engine
 * produced it, and `run` accepts both engines. Deprecating those would tell v2
 * users that the only run-management commands they have are going away, which
 * is false.
 *
 * `schedule`/`schedules` stay visible in help even while deprecated: v2 has no
 * scheduling yet, so they remain the only way to do the job and hiding them
 * would strand the people who depend on them.
 */

import type { Command } from 'commander';

import { deprecateCommand, type DeprecationDependencies } from '../lib/deprecate-command.js';

/** Release that first warned on the v1 relayflows surface. */
const DEPRECATED_SINCE = '12.3.0';

/** The v1-only commands, with what (if anything) replaces each. */
const V1_ONLY_COMMANDS = [
  {
    name: 'schedule',
    // Relayflows v2 ships no scheduling surface: its CLI has `tick start`,
    // which drives a local daemon tick, not a hosted schedule. Naming it here
    // would send people somewhere that cannot do the job.
    note: 'Relayflows v2 has no hosted scheduling yet; this stays supported until it does.',
  },
  {
    name: 'schedules',
    note: 'Relayflows v2 has no hosted scheduling yet; this stays supported until it does.',
  },
] as const;

/**
 * Apply v1 deprecation notices to the `cloud` command group.
 *
 * @param cloudCommand - The registered `cloud` group.
 * @param overrides - Test seam for the warning sink.
 * @throws When an expected v1 command is missing, so a rename cannot silently
 *   drop the deprecation notice.
 */
export function applyV1FlowsDeprecations(
  cloudCommand: Command,
  overrides: Partial<DeprecationDependencies> = {}
): void {
  for (const { name, note } of V1_ONLY_COMMANDS) {
    const command = cloudCommand.commands.find((candidate) => candidate.name() === name);
    if (!command) {
      throw new Error(
        `cannot deprecate \`agent-relay cloud ${name}\`: the command is not registered. ` +
          'Update cloud-v1-deprecations.ts if it was renamed or removed.'
      );
    }
    deprecateCommand(command, { since: DEPRECATED_SINCE, note, keepVisible: true }, overrides);
  }

  deprecateV1RunSelector(cloudCommand, overrides);
}

/**
 * Warn when `cloud run` is asked for the v1 engine explicitly.
 *
 * The command itself is not deprecated — it runs v2 too — so the notice hangs
 * off the selector rather than the command. Only an explicit `v1` warns; an
 * omitted flag leaves the choice to Cloud and says nothing about the caller's
 * intent.
 */
function deprecateV1RunSelector(cloudCommand: Command, overrides: Partial<DeprecationDependencies>): void {
  const warn = overrides.warn ?? ((message: string) => process.stderr.write(message));
  const run = cloudCommand.commands.find((candidate) => candidate.name() === 'run');
  if (!run) {
    throw new Error(
      'cannot deprecate the v1 selector: `agent-relay cloud run` is not registered. ' +
        'Update cloud-v1-deprecations.ts if it was renamed or removed.'
    );
  }

  run.hook('preAction', (_thisCommand, actionCommand) => {
    if (actionCommand.opts()['relayflowVersion'] !== 'v1') return;
    warn(
      `warning: \`--relayflow-version v1\` is deprecated since ${DEPRECATED_SINCE} and will be removed in a future release.\n` +
        '         Use `agent-relay flows run --cloud` for the v2 engine.\n'
    );
  });
}

/**
 * Deprecate the local relayflows v1 workflow runner.
 *
 * `agent-relay node workflow run|logs|sync` executes through `@relayflows/cli`
 * 1.0.1 — the v1 engine — and relayflows v2 covers all three. Unlike the cloud
 * group there is no dual-engine ambiguity here, so these are hidden as well as
 * warned: the replacements are real and the v1 runner should stop being
 * discovered by new users.
 *
 * @param workflowCommand - The registered `node workflow` group.
 * @param overrides - Test seam for the warning sink.
 * @throws When an expected command is missing, so a rename cannot silently
 *   drop the notice.
 */
export function applyV1LocalWorkflowDeprecations(
  workflowCommand: Command,
  overrides: Partial<DeprecationDependencies> = {}
): void {
  const replacements: Record<string, { replacement: string; note?: string }> = {
    run: { replacement: 'agent-relay flows run' },
    logs: {
      replacement: 'agent-relay flows replay',
      note: 'v2 replays a finished run from its local journal rather than tailing a log file.',
    },
    sync: { replacement: 'agent-relay flows sync' },
  };

  for (const [name, notice] of Object.entries(replacements)) {
    const command = workflowCommand.commands.find((candidate) => candidate.name() === name);
    if (!command) {
      throw new Error(
        `cannot deprecate \`${workflowCommand.name()} ${name}\`: the command is not registered. ` +
          'Update cloud-v1-deprecations.ts if it was renamed or removed.'
      );
    }
    deprecateCommand(command, { since: DEPRECATED_SINCE, ...notice }, overrides);
  }
}

/** Names this module deprecates, exported so tests can assert the scope. */
export const V1_DEPRECATED_COMMAND_NAMES: readonly string[] = V1_ONLY_COMMANDS.map((command) => command.name);
