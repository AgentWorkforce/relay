import type { Command } from 'commander';
import { resolveActiveFleetNodeEnrollment } from '@agent-relay/cloud';

import {
  addUpCommandOptions,
  registerCoreCommands,
  withDefaults,
  type CoreDependencies,
  type UpCommandOptions,
} from './core.js';
import { runUpCommand } from '../lib/broker-lifecycle.js';
import { registerLocalAgentCommands } from './local-agent.js';
import { registerLocalWorkflowCommands } from './local-workflow.js';

type ExitFn = (code: number) => never;

export interface NodeCommandDependencies {
  core: CoreDependencies;
  resolveEnrollment: typeof resolveActiveFleetNodeEnrollment;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function withNodeDefaults(overrides: Partial<NodeCommandDependencies> = {}): NodeCommandDependencies {
  const core = overrides.core ?? withDefaults();
  return {
    core,
    resolveEnrollment: resolveActiveFleetNodeEnrollment,
    log: (...args: unknown[]) => console.log(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: core.exit,
    ...overrides,
  };
}

/**
 * Register the `node` command group: `node up|down|status|metrics`, the
 * `node agent …` subtree (+ `node tail`), and `node workflow run|logs|sync`.
 */
export function registerNodeCommands(
  program: Command,
  overrides: Partial<NodeCommandDependencies> = {}
): void {
  const deps = withNodeDefaults(overrides);
  const node = program.command('node').description("Run and manage this machine's relay node");

  // `up` is registered here (not via registerCoreCommands) because the node
  // variant adds `--config` and runs enrollment pickup before delegating.
  addUpCommandOptions(node.command('up').description("Start this node's local broker"))
    .option(
      '--config <file>',
      'Node definition file to serve (defaults to auto-discovered agent-relay.{ts,tsx,mts,cts,js,mjs,cjs})'
    )
    .action(async (options: UpCommandOptions) => {
      await runNodeUp(options, deps);
    });

  // down / status / metrics are the same as `local` — reuse the core
  // registrations without a second `up`.
  registerCoreCommands(node, deps.core, { includeUp: false });

  registerLocalAgentCommands(node);
  registerLocalWorkflowCommands(
    node.command('workflow').description('Run and inspect workflows on this node')
  );
}

/**
 * `node up` with Cloud enrollment pickup: when no `RELAY_NODE_TOKEN` is set,
 * resolve a persisted enrollment and wire its credentials into the env before
 * delegating to the shared broker `up` flow.
 */
async function runNodeUp(options: UpCommandOptions, deps: NodeCommandDependencies): Promise<void> {
  const env = deps.core.env;
  // An explicit workspace key (flag or env) is a direct workspace choice; the
  // enrollment store records workspace ids, not keys, so a stored enrollment
  // cannot be matched against it — skip pickup entirely rather than risk
  // starting the broker with a token from a different workspace.
  const explicitWorkspaceKey = Boolean(options.workspaceKey?.trim() || env.RELAY_WORKSPACE_KEY?.trim());
  let enrolledNodeName: string | undefined;
  if (!env.RELAY_NODE_TOKEN && !explicitWorkspaceKey) {
    let record: ReturnType<typeof resolveActiveFleetNodeEnrollment> | undefined;
    try {
      record = deps.resolveEnrollment({
        ...(env.RELAY_BASE_URL ? { baseUrl: env.RELAY_BASE_URL } : {}),
        env,
      });
    } catch (err) {
      // A missing store resolves to undefined (fine); only an ambiguous
      // multi-match throws, which must surface as a clear CLI error.
      deps.error(err instanceof Error ? err.message : String(err));
      deps.exit(1);
      return;
    }
    if (record) {
      env.RELAY_NODE_TOKEN = record.nodeToken;
      if (!env.RELAY_BASE_URL) {
        env.RELAY_BASE_URL = record.relaycastUrl;
      }
      // Serve under the enrolled name (mirrors the old
      // `fleet serve --enrollment-token` behavior where --name beat the
      // enrollment record's nodeName).
      enrolledNodeName = record.nodeName?.trim() || undefined;
      deps.log(
        `Using persisted Cloud enrollment for node "${record.nodeName}" (workspace ${record.relayWorkspaceId}).`
      );
    }
  }

  await runUpCommand(
    {
      ...options,
      discoverConfig: true,
      ...((options.brokerName ?? enrolledNodeName)
        ? { nodeName: options.brokerName ?? enrolledNodeName }
        : {}),
    },
    deps.core
  );
}
