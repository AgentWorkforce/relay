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
  WorkflowFileType,
  BrokerStartEvent,
  BrokerStopEvent,
  BrokerStartFailedEvent,
  AgentSpawnEvent,
  AgentReleaseEvent,
  AgentCrashEvent,
  MessageSendEvent,
  CliCommandRunEvent,
  CliCommandCompleteEvent,
  WorkflowRunEvent,
  CloudAuthEvent,
  CloudWorkflowRunEvent,
  ProviderAuthEvent,
  SetupInitEvent,
  SwarmRunEvent,
  BridgeSpawnEvent,
  TelemetryEventName,
  TelemetryEventMap,
} from './events.js';

export {
  loadMachineId,
  createAnonymousId,
  getMachineIdPath,
} from './machine-id.js';
