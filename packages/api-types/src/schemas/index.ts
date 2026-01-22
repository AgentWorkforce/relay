/**
 * Schema Exports
 *
 * Re-exports all Zod schemas and their inferred types.
 */

// Agent schemas
export {
  AgentStatusSchema,
  AgentProfileSchema,
  AgentSchema,
  AgentSummarySchema,
  type AgentStatus,
  type AgentProfile,
  type Agent,
  type AgentSummary,
} from './agent.js';

// Message schemas
export {
  MessageStatusSchema,
  AttachmentSchema,
  ThreadMetadataSchema,
  MessageSchema,
  ThreadSchema,
  type MessageStatus,
  type Attachment,
  type ThreadMetadata,
  type Message,
  type Thread,
} from './message.js';

// Session schemas
export {
  SessionClosedBySchema,
  SessionSchema,
  type SessionClosedBy,
  type Session,
} from './session.js';

// Fleet schemas
export {
  PeerServerStatusSchema,
  PeerServerSchema,
  FleetDataSchema,
  ProjectSchema,
  FleetServerSchema,
  FleetStatsSchema,
  type PeerServerStatus,
  type PeerServer,
  type FleetData,
  type Project,
  type FleetServer,
  type FleetStats,
} from './fleet.js';

// Task schemas
export {
  TaskStatusSchema,
  TaskPrioritySchema,
  TaskTypeSchema,
  TaskSchema,
  TaskAssignmentStatusSchema,
  TaskAssignmentPrioritySchema,
  TaskAssignmentSchema,
  type TaskStatus,
  type TaskPriority,
  type TaskType,
  type Task,
  type TaskAssignmentStatus,
  type TaskAssignmentPriority,
  type TaskAssignment,
} from './task.js';

// Decision schemas
export {
  DecisionUrgencySchema,
  DecisionCategorySchema,
  DecisionOptionSchema,
  ApiDecisionSchema,
  DecisionSchema,
  PendingDecisionSchema,
  TrajectoryDecisionTypeSchema,
  TrajectoryDecisionOutcomeSchema,
  TrajectoryDecisionSchema,
  TrajectorySchema,
  type DecisionUrgency,
  type DecisionCategory,
  type DecisionOption,
  type ApiDecision,
  type Decision,
  type PendingDecision,
  type TrajectoryDecisionType,
  type TrajectoryDecisionOutcome,
  type TrajectoryDecision,
  type Trajectory,
} from './decision.js';

// API request/response schemas
export {
  ApiResponseSchema,
  SimpleApiResponseSchema,
  SendMessageRequestSchema,
  SpeakOnTriggerSchema,
  ShadowModeSchema,
  SpawnAgentRequestSchema,
  SpawnAgentResponseSchema,
  CreateTaskRequestSchema,
  CreateBeadRequestSchema,
  SendRelayMessageRequestSchema,
  ActivityEventTypeSchema,
  ActorTypeSchema,
  ActivityEventSchema,
  WSMessageTypeSchema,
  WSMessageSchema,
  DashboardStateSchema,
  type SimpleApiResponse,
  type SendMessageRequest,
  type SpeakOnTrigger,
  type ShadowMode,
  type SpawnAgentRequest,
  type SpawnAgentResponse,
  type CreateTaskRequest,
  type CreateBeadRequest,
  type SendRelayMessageRequest,
  type ActivityEventType,
  type ActorType,
  type ActivityEvent,
  type WSMessageType,
  type WSMessage,
  type DashboardState,
} from './api.js';

// History schemas
export {
  HistorySessionSchema,
  HistoryMessageSchema,
  ConversationSchema,
  HistoryStatsSchema,
  FileSearchResultSchema,
  FileSearchResponseSchema,
  type HistorySession,
  type HistoryMessage,
  type Conversation,
  type HistoryStats,
  type FileSearchResult,
  type FileSearchResponse,
} from './history.js';
