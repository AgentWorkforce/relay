/**
 * Shared types for PTY wrappers (RelayPtyOrchestrator, PtyWrapper)
 *
 * These types are used for event handling across different wrapper implementations.
 */

import type { ParsedSummary, SessionEndMarker } from './parser.js';

/**
 * Event emitted when message injection fails after all retries
 */
export interface InjectionFailedEvent {
  messageId: string;
  from: string;
  attempts: number;
}

/**
 * Event emitted when agent outputs a [[SUMMARY]] block
 * Cloud services can persist this for session tracking
 */
export interface SummaryEvent {
  agentName: string;
  summary: ParsedSummary;
}

/**
 * Event emitted when agent outputs a [[SESSION_END]] block
 * Cloud services can handle session closure
 */
export interface SessionEndEvent {
  agentName: string;
  marker: SessionEndMarker;
}

/**
 * Event emitted when auth revocation is detected
 * Cloud services can handle re-auth flow
 */
export interface AuthRevokedEvent {
  agentName: string;
  provider: string;
  message?: string;
  confidence: 'high' | 'medium' | 'low';
}
