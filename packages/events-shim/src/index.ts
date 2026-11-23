/**
 * @agent-relay/events-shim — one MCP URL that turns webhook posts into
 * Agent Relay messages that wake an idle agent session.
 *
 * Hosts (Agent Relay Cloud, relay-control) provide an `EventsShimStore`
 * and mount `handleEventsShimRequest`; everything else lives here.
 */
export { EVENTS_SHIM_LIMITS, type EventsShimLimits } from './limits.js';
export { WAKE_AGENT_NAME_PATTERN, wakeAgentName } from './agent-name.js';
export {
  mintToken,
  sha256Hex,
  hmacSha256Hex,
  hmacSha256Base64,
  base64ToBytes,
  bytesToBase64,
  timingSafeEqual,
} from './crypto.js';
export {
  VERIFICATION_MODES,
  type DeliveryState,
  type EventsShimStore,
  type MintedShim,
  type NewShimEvent,
  type SecretMode,
  type ShimEvent,
  type ShimRecord,
  type ShimUrls,
  type VerificationMode,
  type WakeTarget,
} from './types.js';
export {
  verifyInbound,
  idempotencyKeyFor,
  eventTypeFor,
  keptHeaders,
  mcpWebhookKey,
  MCP_WEBHOOK_SECRET_PATTERN,
  type HeaderReader,
  type VerifyResult,
} from './verify.js';
export {
  checkWakeTarget,
  forwardWake,
  isNudge,
  neutraliseMentions,
  wakeText,
  DEFAULT_RELAY_ORIGINS,
  type WakeResult,
  type WakeTargetCheck,
} from './wake.js';
export {
  BEARER_SECRET_PREFIX,
  HOOK_TOKEN_PREFIX,
  MANAGE_TOKEN_PREFIX,
  MCP_TOKEN_PREFIX,
  EventsShimInputError,
  createShim,
  feedFor,
  findShimByManageToken,
  mintMcpWebhookSecret,
  findShimByMcpToken,
  publicEvent,
  drainStalledWakes,
  receivePost,
  rotateHook,
  setModeSecret,
  type EventsShimDeps,
  type PostOutcome,
} from './service.js';
export {
  EVENTS_SHIM_INSTRUCTIONS,
  EVENTS_SHIM_SERVER_NAME,
  RELAY_WEBHOOK_COMMAND,
  buildEventsShimMcpServer,
  registerEventsShimTools,
  type EventsShimMcpContext,
} from './mcp.js';
export {
  deliverInBackground,
  deliverPending,
  recoverStalledWakes,
  WAKE_RECOVERY_DELAYS_MS,
  WAKE_RETRY_DELAYS_MS,
  type DeliveryDeps,
  type DeliveryPass,
  type WakeSweep,
} from './delivery.js';
export { handleEventsShimRequest, type EventsShimHttpOptions } from './http.js';
export { MemoryEventsShimStore } from './memory-store.js';
export {
  MCP_EVENTS_ERRORS,
  MCP_EVENTS_EXTENSION,
  MCP_EVENTS_LIMITS,
  WEBHOOK_RECEIVED_EVENT,
  advertiseEventsExtension,
  handleEventsRequest,
  isEventsRequest,
  webhookReceivedEventType,
  type McpEventsContext,
} from './events.js';
