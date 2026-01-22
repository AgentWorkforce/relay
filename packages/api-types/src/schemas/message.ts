/**
 * Message Schemas
 *
 * Zod schemas for message-related types used across the dashboard and API.
 */

import { z } from 'zod';

/**
 * Message status enum
 */
export const MessageStatusSchema = z.enum(['unread', 'read', 'acked', 'sending', 'failed']);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/**
 * Attachment schema - files/images attached to messages
 */
export const AttachmentSchema = z.object({
  /** Unique identifier for the attachment */
  id: z.string(),
  /** Original filename */
  filename: z.string(),
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
  mimeType: z.string(),
  /** Size in bytes */
  size: z.number(),
  /** URL to access the attachment */
  url: z.string(),
  /** Absolute file path for agents to read the file directly */
  filePath: z.string().optional(),
  /** Width for images */
  width: z.number().optional(),
  /** Height for images */
  height: z.number().optional(),
  /** Base64-encoded data (for inline display, optional) */
  data: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Thread metadata schema
 */
export const ThreadMetadataSchema = z.object({
  id: z.string(),
  rootMessage: z.string(),
  participantCount: z.number(),
  messageCount: z.number(),
  lastActivityAt: z.string(),
});
export type ThreadMetadata = z.infer<typeof ThreadMetadataSchema>;

/**
 * Message schema
 */
export const MessageSchema = z.object({
  /** Unique message ID */
  id: z.string(),
  /** Sender agent name */
  from: z.string(),
  /** Recipient agent name or '*' for broadcast */
  to: z.string(),
  /** Message content */
  content: z.string(),
  /** Timestamp (ISO string) */
  timestamp: z.string(),
  /** Optional thread ID for threading */
  thread: z.string().optional(),
  /** Whether this is a broadcast message */
  isBroadcast: z.boolean().optional(),
  /** Whether the message has been read */
  isRead: z.boolean().optional(),
  /** Number of replies in thread */
  replyCount: z.number().optional(),
  /** Thread summary metadata */
  threadSummary: ThreadMetadataSchema.optional(),
  /** Message delivery status */
  status: MessageStatusSchema.optional(),
  /** Attached files/images */
  attachments: z.array(AttachmentSchema).optional(),
  /** Channel context for routing */
  channel: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/**
 * Thread schema - collection of messages
 */
export const ThreadSchema = z.object({
  /** Thread ID */
  id: z.string(),
  /** Messages in the thread */
  messages: z.array(MessageSchema),
  /** Participant agent names */
  participants: z.array(z.string()),
  /** Last activity timestamp */
  lastActivity: z.string(),
});
export type Thread = z.infer<typeof ThreadSchema>;
