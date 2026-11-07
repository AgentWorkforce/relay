import { SubscribableEventTypeSchema, type SubscribableEventType } from '@relaycast/types';

/**
 * Every event a Relaycast subscription accepts, taken from the engine's own
 * schema so a CLI allowlist cannot drift narrower than the server.
 */
export const SUBSCRIBABLE_EVENT_TYPES: readonly SubscribableEventType[] = SubscribableEventTypeSchema.options;
