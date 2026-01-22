/**
 * API Request/Response Schemas
 *
 * Zod schemas for API request and response types.
 */

import { z } from 'zod';

/**
 * Generic API response schema
 */
export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
  });

/**
 * Simple success/error response
 */
export const SimpleApiResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export type SimpleApiResponse = z.infer<typeof SimpleApiResponseSchema>;

/**
 * Send message request schema
 */
export const SendMessageRequestSchema = z.object({
  to: z.string(),
  message: z.string(),
  thread: z.string().optional(),
  /** Attachment IDs to include with the message */
  attachments: z.array(z.string()).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * Speak on trigger enum (for shadow agents)
 */
export const SpeakOnTriggerSchema = z.enum([
  'SESSION_END',
  'CODE_WRITTEN',
  'REVIEW_REQUEST',
  'EXPLICIT_ASK',
  'ALL_MESSAGES',
]);
export type SpeakOnTrigger = z.infer<typeof SpeakOnTriggerSchema>;

/**
 * Shadow mode enum
 */
export const ShadowModeSchema = z.enum(['subagent', 'process']);
export type ShadowMode = z.infer<typeof ShadowModeSchema>;

/**
 * Spawn agent request schema
 */
export const SpawnAgentRequestSchema = z.object({
  name: z.string(),
  cli: z.string().optional(),
  task: z.string().optional(),
  team: z.string().optional(),
  /** Shadow execution mode */
  shadowMode: ShadowModeSchema.optional(),
  /** Primary agent to shadow */
  shadowOf: z.string().optional(),
  /** Shadow agent profile to use */
  shadowAgent: z.string().optional(),
  /** When the shadow should be invoked */
  shadowTriggers: z.array(SpeakOnTriggerSchema).optional(),
  /** When the shadow should speak */
  shadowSpeakOn: z.array(SpeakOnTriggerSchema).optional(),
});
export type SpawnAgentRequest = z.infer<typeof SpawnAgentRequestSchema>;

/**
 * Spawn agent response schema
 */
export const SpawnAgentResponseSchema = z.object({
  success: z.boolean(),
  name: z.string(),
  error: z.string().optional(),
});
export type SpawnAgentResponse = z.infer<typeof SpawnAgentResponseSchema>;

/**
 * Create task request schema
 */
export const CreateTaskRequestSchema = z.object({
  agentName: z.string(),
  title: z.string(),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/**
 * Create bead request schema
 */
export const CreateBeadRequestSchema = z.object({
  title: z.string(),
  assignee: z.string().optional(),
  priority: z.number().optional(),
  type: z.enum(['task', 'bug', 'feature']).optional(),
  description: z.string().optional(),
});
export type CreateBeadRequest = z.infer<typeof CreateBeadRequestSchema>;

/**
 * Send relay message request schema
 */
export const SendRelayMessageRequestSchema = z.object({
  to: z.string(),
  content: z.string(),
  thread: z.string().optional(),
});
export type SendRelayMessageRequest = z.infer<typeof SendRelayMessageRequestSchema>;

/**
 * Activity event type enum
 */
export const ActivityEventTypeSchema = z.enum([
  'agent_spawned',
  'agent_released',
  'agent_online',
  'agent_offline',
  'user_joined',
  'user_left',
  'broadcast',
  'error',
]);
export type ActivityEventType = z.infer<typeof ActivityEventTypeSchema>;

/**
 * Actor type enum
 */
export const ActorTypeSchema = z.enum(['user', 'agent', 'system']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

/**
 * Activity event schema
 */
export const ActivityEventSchema = z.object({
  id: z.string(),
  type: ActivityEventTypeSchema,
  timestamp: z.string(),
  /** Actor who triggered the event */
  actor: z.string(),
  /** Optional avatar URL for the actor */
  actorAvatarUrl: z.string().optional(),
  /** Whether actor is a user or agent */
  actorType: ActorTypeSchema,
  /** Event title for display */
  title: z.string(),
  /** Optional detailed description */
  description: z.string().optional(),
  /** Optional metadata */
  metadata: z.record(z.unknown()).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/**
 * WebSocket message type enum
 */
export const WSMessageTypeSchema = z.enum(['data', 'agents', 'messages', 'fleet', 'error']);
export type WSMessageType = z.infer<typeof WSMessageTypeSchema>;

/**
 * WebSocket message schema
 */
export const WSMessageSchema = z.object({
  type: WSMessageTypeSchema,
  payload: z.unknown(),
});
export type WSMessage = z.infer<typeof WSMessageSchema>;

/**
 * Dashboard state schema
 */
export const DashboardStateSchema = z.object({
  agents: z.array(z.lazy(() => z.any())), // References AgentSchema
  messages: z.array(z.lazy(() => z.any())), // References MessageSchema
  currentChannel: z.string(),
  currentThread: z.string().nullable(),
  isConnected: z.boolean(),
  viewMode: z.enum(['local', 'fleet']),
  fleetData: z.lazy(() => z.any()).nullable(), // References FleetDataSchema
  sessions: z.array(z.lazy(() => z.any())), // References SessionSchema
  summaries: z.array(z.lazy(() => z.any())), // References AgentSummarySchema
});
export type DashboardState = z.infer<typeof DashboardStateSchema>;
