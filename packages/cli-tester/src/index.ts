/**
 * CLI Auth Tester - Manual interactive testing for CLI authentication flows
 *
 * This package provides utilities for testing CLI authentication in a Docker container.
 * Primary use case is debugging auth issues with various CLI tools (Claude, Codex, Gemini, etc.)
 *
 * @example
 * ```bash
 * # Start the test environment
 * npm run cli-tester:start
 *
 * # Inside container, test a CLI
 * ./scripts/test-cli.sh claude
 *
 * # Verify credentials
 * ./scripts/verify-auth.sh claude
 * ```
 */

export {
  RelayPtyClient,
  createClient,
  getSocketPath,
  type InjectRequest,
  type InjectResponse,
  type StatusRequest,
  type StatusResponse,
  type RelayPtyResponse,
} from './utils/socket-client.js';

export {
  checkCredentials,
  clearCredentials,
  checkAllCredentials,
  clearAllCredentials,
  getCredentialPath,
  getConfigPaths,
  type CLIType,
  type CredentialCheck,
} from './utils/credential-check.js';
