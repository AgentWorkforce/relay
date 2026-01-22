/**
 * History Schemas
 *
 * Zod schemas for conversation history types used across the dashboard and API.
 */

import { z } from 'zod';

/**
 * History session schema
 */
export const HistorySessionSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  cli: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  duration: z.string(),
  messageCount: z.number(),
  summary: z.string().optional(),
  isActive: z.boolean(),
  closedBy: z.enum(['agent', 'disconnect', 'error']).optional(),
});
export type HistorySession = z.infer<typeof HistorySessionSchema>;

/**
 * History message schema
 */
export const HistoryMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  content: z.string(),
  timestamp: z.string(),
  thread: z.string().optional(),
  isBroadcast: z.boolean().optional(),
  isUrgent: z.boolean().optional(),
  status: z.string().optional(),
  data: z.record(z.unknown()).optional(),
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

/**
 * Conversation schema (unique agent pairs)
 */
export const ConversationSchema = z.object({
  participants: z.array(z.string()),
  lastMessage: z.string(),
  lastTimestamp: z.string(),
  messageCount: z.number(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * History stats schema
 */
export const HistoryStatsSchema = z.object({
  messageCount: z.union([z.number(), z.string()]),
  sessionCount: z.union([z.number(), z.string()]),
  activeSessions: z.union([z.number(), z.string()]),
  uniqueAgents: z.union([z.number(), z.string()]),
  oldestMessageDate: z.string().nullable().optional(),
});
export type HistoryStats = z.infer<typeof HistoryStatsSchema>;

/**
 * File search result schema
 */
export const FileSearchResultSchema = z.object({
  path: z.string(),
  name: z.string(),
  isDirectory: z.boolean(),
});
export type FileSearchResult = z.infer<typeof FileSearchResultSchema>;

/**
 * File search response schema
 */
export const FileSearchResponseSchema = z.object({
  files: z.array(FileSearchResultSchema),
  query: z.string(),
  searchRoot: z.string(),
});
export type FileSearchResponse = z.infer<typeof FileSearchResponseSchema>;
