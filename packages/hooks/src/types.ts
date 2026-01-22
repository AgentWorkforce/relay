/**
 * Agent Relay Hook Types
 *
 * Core types for the agent-relay hooks system. Hooks allow agents to intercept
 * and modify behavior at various points in the agent lifecycle.
 */

import type { SendPayload } from '@agent-relay/protocol/types';
import { PROTOCOL_VERSION } from '@agent-relay/protocol';

/**
 * A message in the conversation history
 */
export interface ConversationMessage {
  /** Role of the message sender */
  role: 'user' | 'assistant' | 'system';
  /** Message content */
  content: string;
  /** Timestamp when the message was created */
  timestamp?: number;
}

/**
 * Output from the agent (tool calls, responses, etc.)
 */
export interface AgentOutput {
  /** Type of output */
  type: 'text' | 'tool_call' | 'tool_result';
  /** Content of the output */
  content: string;
  /** Tool name if type is tool_call or tool_result */
  tool?: string;
  /** Timestamp of the output */
  timestamp: number;
}

/**
 * Memory interface for persisting data across hook invocations
 */
export interface HookMemory {
  /** Get a value from memory */
  get<T = unknown>(key: string): T | undefined;
  /** Set a value in memory */
  set<T = unknown>(key: string, value: T): void;
  /** Delete a value from memory */
  delete(key: string): boolean;
  /** Check if a key exists */
  has(key: string): boolean;
  /** Clear all memory */
  clear(): void;
}

/**
 * Relay interface for sending messages to other agents
 */
export interface HookRelay {
  /** Send a message to a specific agent or broadcast */
  send(to: string | '*', body: string, options?: Partial<SendPayload>): Promise<void>;
  /** Check if connected to the relay daemon */
  isConnected(): boolean;
  /** Get the current agent's name in the relay */
  getAgentName(): string | undefined;
}

/**
 * Context provided to hooks during execution
 *
 * This interface provides hooks with access to the current execution context,
 * allowing them to inspect and modify agent behavior.
 */
export interface HookContext {
  /** Unique identifier for this agent instance */
  agentId: string;

  /** Session identifier for the current conversation */
  sessionId: string;

  /** Working directory of the agent */
  workingDir: string;

  /** Environment variables available to the hook */
  env: Record<string, string | undefined>;

  /**
   * Inject content into the agent's input stream.
   * This content will be processed as if it came from the user.
   * @param content - The content to inject
   */
  inject(content: string): void;

  /**
   * Send a message through the relay to other agents.
   * @param to - Target agent name or '*' for broadcast
   * @param body - Message body
   * @param options - Optional message options
   */
  send(to: string | '*', body: string, options?: Partial<SendPayload>): Promise<void>;

  /** Persistent memory for storing data across hook invocations */
  memory: HookMemory;

  /** Relay interface for agent communication */
  relay: HookRelay;

  /** Array of outputs from the current agent turn */
  output: AgentOutput[];

  /** Conversation message history */
  messages: ConversationMessage[];
}

/**
 * Result returned by a hook execution
 *
 * Hooks can modify agent behavior by returning specific fields:
 * - inject: Add content to the agent's input
 * - suppress: Prevent the triggering action from executing
 * - stop: Halt further hook processing
 */
export interface HookResult {
  /**
   * Content to inject into the agent's input stream.
   * If provided, this content will be processed as user input.
   */
  inject?: string;

  /**
   * If true, suppress the action that triggered the hook.
   * For example, on a Stop hook, this would prevent the agent from stopping.
   */
  suppress?: boolean;

  /**
   * If true, stop processing any remaining hooks in the chain.
   * The current hook's result will be the final result.
   */
  stop?: boolean;
}

/**
 * Hook event types that can trigger hook execution
 */
export type HookEventType =
  | 'PreToolCall'
  | 'PostToolCall'
  | 'Stop'
  | 'Start'
  | 'Error'
  | 'Message';

/**
 * Configuration for a hook
 */
export interface HookConfig {
  /** The event type that triggers this hook */
  event: HookEventType;
  /** Command to execute for the hook */
  command: string;
  /** Optional working directory for the command */
  workingDir?: string;
  /** Optional timeout in milliseconds */
  timeout?: number;
  /** Whether this hook is enabled */
  enabled?: boolean;
}

/**
 * Handler function signature for programmatic hooks
 */
export type HookHandler = (context: HookContext) => HookResult | Promise<HookResult>;

// ============================================================================
// Lifecycle Hook Types
// ============================================================================

/**
 * Extended context for session start hooks
 */
export interface SessionStartContext extends HookContext {
  /** Task description if agent was started with a task */
  task?: string;
  /** Task ID if linked to external system */
  taskId?: string;
  /** Task source (e.g., 'beads', 'linear', 'github') */
  taskSource?: string;
}

/**
 * Extended context for session end hooks
 */
export interface SessionEndContext extends HookContext {
  /** Exit code if available */
  exitCode?: number;
  /** Duration of the session in milliseconds */
  duration: number;
  /** Whether the session ended gracefully */
  graceful: boolean;
}

/**
 * Extended context for output hooks
 */
export interface OutputContext extends HookContext {
  /** Cleaned output (ANSI codes stripped) */
  content: string;
  /** Raw output with ANSI codes */
  rawContent: string;
  /** Whether this is a complete line */
  isComplete: boolean;
}

/**
 * Extended context for message received hooks
 */
export interface MessageReceivedContext extends HookContext {
  /** Sender agent name */
  from: string;
  /** Message body */
  body: string;
  /** Message ID */
  messageId: string;
  /** Thread ID if threaded */
  thread?: string;
}

/**
 * Extended context for message sent hooks
 */
export interface MessageSentContext extends HookContext {
  /** Target agent name */
  to: string;
  /** Message body */
  body: string;
  /** Thread ID if threaded */
  thread?: string;
}

/**
 * Extended context for idle hooks
 */
export interface IdleContext extends HookContext {
  /** Duration of inactivity in milliseconds */
  idleDuration: number;
  /** Number of times idle hook has fired this session */
  idleCount: number;
}

/**
 * Extended context for error hooks
 */
export interface ErrorContext extends HookContext {
  /** The error that occurred */
  error: Error;
  /** Phase where error occurred (e.g., 'output', 'message', 'tool') */
  phase?: string;
}

/**
 * Lifecycle hook handler types
 */
export type OnSessionStartHook = (ctx: SessionStartContext) => Promise<HookResult | void> | HookResult | void;
export type OnSessionEndHook = (ctx: SessionEndContext) => Promise<HookResult | void> | HookResult | void;
export type OnOutputHook = (ctx: OutputContext) => Promise<HookResult | void> | HookResult | void;
export type OnMessageReceivedHook = (ctx: MessageReceivedContext) => Promise<HookResult | void> | HookResult | void;
export type OnMessageSentHook = (ctx: MessageSentContext) => Promise<HookResult | void> | HookResult | void;
export type OnIdleHook = (ctx: IdleContext) => Promise<HookResult | void> | HookResult | void;
export type OnErrorHook = (ctx: ErrorContext) => Promise<HookResult | void> | HookResult | void;

/**
 * Lifecycle hook definitions for registration
 */
export interface LifecycleHooks {
  onSessionStart?: OnSessionStartHook | OnSessionStartHook[];
  onSessionEnd?: OnSessionEndHook | OnSessionEndHook[];
  onOutput?: OnOutputHook | OnOutputHook[];
  onMessageReceived?: OnMessageReceivedHook | OnMessageReceivedHook[];
  onMessageSent?: OnMessageSentHook | OnMessageSentHook[];
  onIdle?: OnIdleHook | OnIdleHook[];
  onError?: OnErrorHook | OnErrorHook[];
}

/**
 * Lifecycle hook event names
 */
export type LifecycleHookEvent =
  | 'sessionStart'
  | 'sessionEnd'
  | 'output'
  | 'messageReceived'
  | 'messageSent'
  | 'idle'
  | 'error';

/**
 * Pattern handler for custom namespaces (e.g., @deploy:, @notify:)
 */
export type PatternHandler = (
  target: string,
  message: string,
  ctx: HookContext
) => Promise<HookResult | void> | HookResult | void;

/**
 * Memory configuration for hooks
 */
export interface HooksMemoryConfig {
  /** Memory adapter type: 'inmemory', 'supermemory', etc. */
  type?: string;
  /** API key for external memory services */
  apiKey?: string;
  /** Custom API endpoint */
  endpoint?: string;
  /** Whether to inject memories on session start */
  injectOnStart?: boolean;
  /** Maximum memories to inject on start */
  maxStartMemories?: number;
  /** Whether to prompt for memory save on session end */
  promptOnEnd?: boolean;
  /** Whether to auto-save detected learnings (default: true) */
  autoSave?: boolean;
  /** Whether to track learnings for session-end summary (default: true) */
  autoSaveOnEnd?: boolean;
}

/**
 * Full hooks configuration
 */
export interface HooksConfig {
  /** Lifecycle hooks */
  hooks?: LifecycleHooks;
  /** Pattern handlers by namespace */
  patterns?: Record<string, PatternHandler | 'builtin'>;
  /** Idle timeout in milliseconds (default: 30000) */
  idleTimeout?: number;
  /** Whether to enable trajectory tracking hooks */
  trajectoryTracking?: boolean;
  /** Memory system configuration */
  memory?: HooksMemoryConfig | boolean;
}

// Hook ABI version aligns with protocol wire version
export const HOOK_ABI_VERSION = PROTOCOL_VERSION;
