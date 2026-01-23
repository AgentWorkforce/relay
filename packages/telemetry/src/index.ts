/**
 * @agent-relay/telemetry - Anonymous usage analytics (opt-out via env or CLI)
 */

export {
  initTelemetry,
  track,
  shutdown,
  isEnabled,
  getAnonymousId,
  getStatus,
} from './client.js';

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

export {
  loadMachineId,
  createAnonymousId,
  getMachineIdPath,
} from './machine-id.js';
