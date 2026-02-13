// Compatibility module: keep both naming conventions available during migration.
export {
  findRelayPtyBinary,
  hasRelayPtyBinary,
  getCachedRelayPtyPath,
  getLastSearchPaths,
  clearBinaryCache,
  isPlatformSupported,
  getSupportedPlatforms,
} from './relay-pty-path.js';

export {
  findRelayPtyBinary as findAgentRelayBinary,
  hasRelayPtyBinary as hasAgentRelayBinary,
  getCachedRelayPtyPath as getCachedAgentRelayPath,
} from './relay-pty-path.js';
