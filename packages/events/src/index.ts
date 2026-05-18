import { FeatureNotImplementedError, type RelayfileToolsOptions, type RelayfileToolset } from './types.js';

/**
 * M2 relayfile-backed tool generation used by hosted-agent and BYO-agent paths.
 */
export function relayfileTools(options: RelayfileToolsOptions): RelayfileToolset {
  const client = options.client ?? null;
  const fail = () => {
    throw new FeatureNotImplementedError(
      'M2_NOT_IMPLEMENTED',
      `relayfileTools() requires a live relayfile client for workspace ${options.workspace}`
    );
  };

  return {
    available: client?.available !== false && client !== null,
    read: async (path) => (client ? client.read(path) : fail()),
    write: async (path, body) => (client ? client.write(path, body) : fail()),
    list: async (glob) => (client ? client.list(glob) : fail()),
  };
}

export { createExpander } from './expand.js';
export { bindLogger, createLogger, normalizeLogLevel } from './logger.js';
export {
  createAgentEvent,
  createCronTickEvent,
  createStartupEvent,
  createTransportErrorEvent,
  isCronTickEvent,
  isRelaycastMessageEvent,
  isRelayfileChangeEvent,
  isStartupEvent,
  isTransportErrorEvent,
  toAgentEventRecord,
} from './envelope.js';
export { DEFAULT_RETRY_DELAYS_MS, computeRetryDelayMs, delay, withRetry } from './retry.js';
export {
  flushRuntimeOtelForTests,
  getRuntimeTracer,
  initializeRuntimeOtel,
  injectTraceContextIntoCarrier,
  resetRuntimeOtelForTests,
  withRuntimeSpan,
} from './otel.js';
export { events } from './transport.js';
export { FeatureNotImplementedError, NoRetry } from './types.js';
export type {
  AgentEvent,
  AgentEventMap,
  AgentEventResourceDataMap,
  BaseAgentEvent,
  ChangeEvent,
  CronTickEvent,
  DiffExpansion,
  EventActorSummary,
  EventDispatchErrorHandler,
  EventHandler,
  EventResource,
  EventStreamHandle,
  EventStreamOptions,
  EventSummary,
  ExpansionForResource,
  EventType,
  Expansion,
  ExpansionLevel,
  FeatureNotImplementedCode,
  FullExpansion,
  GatewayRegistrationResult,
  LogFields,
  LogLevel,
  Logger,
  ProviderEventType,
  RelaycastMessageEvent,
  RelayfileChangeEvent,
  RelayfileToolset,
  RelayfileToolsOptions,
  StartupEvent,
  StartupReason,
  SummaryExpansion,
  ThreadExpansion,
  ThreadItem,
  ThreadItemAuthor,
  ThreadExpansionOptions,
  TransportErrorEvent,
  StructuredLogEntry,
  WatchRegistration,
  WatchRegistrationInput,
  WatchReplayOnStart,
  WebSocketFactory,
} from './types.js';
