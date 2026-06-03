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
  type InitTelemetryOptions,
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
  TelemetryApp,
  TelemetrySurface,
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
  SdkMethodCallEvent,
  SdkWorkflowRunEvent,
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

export { loadMachineId, createAnonymousId, getMachineIdPath } from './machine-id.js';

export {
  ORCHESTRATOR_HARNESS_ENV,
  UNKNOWN_ORCHESTRATOR_HARNESS,
  detectOrchestratorHarness,
  inferHarnessFromCommand,
  sanitizeOrchestratorHarness,
  type DetectOrchestratorHarnessOptions,
  type ProcessInfo,
} from './orchestrator-harness.js';
