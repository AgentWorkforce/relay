/**
 * Re-exports the SSH interactive session helpers from `@agent-relay/cloud`.
 *
 * The implementation lives in the cloud SDK so external CLIs can import it
 * directly. This module exists to keep existing relative imports stable.
 */

export {
  runInteractiveSession,
  formatShellInvocation,
  wrapWithLaunchCheckpoint,
  type SshConnectionInfo,
  type InteractiveSessionOptions,
  type InteractiveSessionResult,
} from '@agent-relay/cloud';
