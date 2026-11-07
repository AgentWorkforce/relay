export const MINIMUM_NODE_MAJOR = 22;

/** Fail before CLI initialization when Relay is run on an unsupported Node release. */
export function assertSupportedNodeVersion(version = process.versions.node): void {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error(
      `Agent Relay requires Node.js ${MINIMUM_NODE_MAJOR} or newer (found ${version}). Upgrade Node.js before running agent-relay.`
    );
  }
}
