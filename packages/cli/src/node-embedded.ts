/**
 * Process-safe broker lifecycle entry point for long-lived Node.js hosts.
 *
 * Unlike the CLI command, these functions never call process.exit, install
 * global signal handlers, or write lifecycle output directly to the console.
 */
export {
  BrokerLifecycleExitError,
  downEmbeddedNode,
  startEmbeddedNode,
  statusEmbeddedNode,
  type EmbeddedNodeCommandFailure,
  type EmbeddedNodeCommandResult,
  type EmbeddedNodeCommandSuccess,
  type EmbeddedNodeDownOptions,
  type EmbeddedNodeHandle,
  type EmbeddedNodeOutput,
  type EmbeddedNodeOutputLevel,
  type EmbeddedNodeRuntimeOptions,
  type EmbeddedNodeStartOptions,
  type EmbeddedNodeStartResult,
  type EmbeddedNodeStatusOptions,
} from './cli/lib/node-embedded.js';
