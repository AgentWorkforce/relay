/**
 * @agent-relay/telemetry
 *
 * Anonymous telemetry for Agent Relay usage analytics.
 * Enabled by default with opt-out via environment variable or CLI.
 */

// Client exports
export {
  initTelemetry,
  track,
  shutdown,
  isEnabled,
  getAnonymousId,
  getStatus,
} from './client.js';

// Config exports
export {
  isTelemetryEnabled,
  enableTelemetry,
  disableTelemetry,
  wasNotified,
  markNotified,
  loadPrefs,
  savePrefs,
  getPrefsPath,
  isDisabledByEnv,
  type TelemetryPrefs,
} from './config.js';

// Event types
export type {
  CommonProperties,
  ActionSource,
  ReleaseReason,
  DaemonStartEvent,
  DaemonStopEvent,
  AgentSpawnEvent,
  AgentReleaseEvent,
  AgentCrashEvent,
  MessageSendEvent,
  CliCommandRunEvent,
  TelemetryEventName,
  TelemetryEventMap,
} from './events.js';

// Machine ID utilities
export {
  loadMachineId,
  createAnonymousId,
  getMachineIdPath,
} from './machine-id.js';
