/**
 * Hook Registry
 *
 * Manages lifecycle hooks and pattern handlers for agent sessions.
 * Provides a centralized way to register, unregister, and dispatch hooks.
 */

import { randomUUID } from 'node:crypto';
import type {
  HookContext,
  HookResult,
  HookMemory,
  HookRelay,
  AgentOutput,
  ConversationMessage,
  LifecycleHooks,
  LifecycleHookEvent,
  PatternHandler,
  HooksConfig,
  HooksMemoryConfig,
  SessionStartContext,
  SessionEndContext,
  OutputContext,
  MessageReceivedContext,
  MessageSentContext,
  IdleContext,
  ErrorContext,
  OnSessionStartHook,
  OnSessionEndHook,
  OnOutputHook,
  OnMessageReceivedHook,
  OnMessageSentHook,
  OnIdleHook,
  OnErrorHook,
} from './types.js';

/**
 * Simple in-memory implementation of HookMemory
 */
class InMemoryHookMemory implements HookMemory {
  private store = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.store.set(key, value);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Options for creating a HookRegistry
 */
export interface HookRegistryOptions {
  /** Agent identifier */
  agentId?: string;
  /** Agent name for relay */
  agentName?: string;
  /** Working directory */
  workingDir?: string;
  /** Project identifier */
  projectId?: string;
  /** Environment variables */
  env?: Record<string, string | undefined>;
  /** Task description */
  task?: string;
  /** Task ID */
  taskId?: string;
  /** Task source */
  taskSource?: string;
  /** Idle timeout in ms (default: 30000) */
  idleTimeout?: number;
  /** Function to inject text into agent */
  inject?: (text: string) => void;
  /** Function to send relay messages */
  send?: (to: string, body: string) => Promise<void>;
}

/**
 * HookRegistry manages lifecycle hooks and dispatches events
 */
export class HookRegistry {
  private sessionId: string;
  private agentId: string;
  private agentName: string;
  private workingDir: string;
  private projectId: string;
  private env: Record<string, string | undefined>;
  private task?: string;
  private taskId?: string;
  private taskSource?: string;

  private memory: HookMemory;
  private relay: HookRelay;
  private outputHistory: AgentOutput[] = [];
  private messageHistory: ConversationMessage[] = [];

  private sessionStartHooks: OnSessionStartHook[] = [];
  private sessionEndHooks: OnSessionEndHook[] = [];
  private outputHooks: OnOutputHook[] = [];
  private messageReceivedHooks: OnMessageReceivedHook[] = [];
  private messageSentHooks: OnMessageSentHook[] = [];
  private idleHooks: OnIdleHook[] = [];
  private errorHooks: OnErrorHook[] = [];

  private patternHandlers = new Map<string, PatternHandler>();

  private idleTimeout: number;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private idleCount = 0;
  private lastActivityTime = Date.now();
  private sessionStartTime = Date.now();

  private injectFn?: (text: string) => void;
  private sendFn?: (to: string, body: string) => Promise<void>;

  constructor(options: HookRegistryOptions = {}) {
    this.sessionId = randomUUID();
    this.agentId = options.agentId ?? randomUUID();
    this.agentName = options.agentName ?? 'agent';
    this.workingDir = options.workingDir ?? process.cwd();
    this.projectId = options.projectId ?? 'default';
    this.env = options.env ?? {};
    this.task = options.task;
    this.taskId = options.taskId;
    this.taskSource = options.taskSource;
    this.idleTimeout = options.idleTimeout ?? 30000;
    this.injectFn = options.inject;
    this.sendFn = options.send;

    this.memory = new InMemoryHookMemory();

    // Create relay interface (using arrow functions to capture 'this')
    this.relay = {
      send: async (to: string, body: string): Promise<void> => {
        if (this.sendFn) {
          await this.sendFn(to, body);
        }
      },
      isConnected: (): boolean => {
        return !!this.sendFn;
      },
      getAgentName: (): string | undefined => {
        return this.agentName;
      },
    };
  }

  /**
   * Register hooks from a configuration object
   */
  registerHooks(config: HooksConfig): void {
    if (config.hooks) {
      this.registerLifecycleHooks(config.hooks);
    }

    if (config.patterns) {
      for (const [namespace, handler] of Object.entries(config.patterns)) {
        if (handler !== 'builtin') {
          this.registerPattern(namespace, handler);
        }
      }
    }

    if (config.idleTimeout !== undefined) {
      this.idleTimeout = config.idleTimeout;
    }

    // Register memory hooks if configured
    if (config.memory) {
      this.registerMemoryHooksFromConfig(config.memory);
    }
  }

  /**
   * Register memory hooks from configuration
   */
  private async registerMemoryHooksFromConfig(
    config: HooksMemoryConfig | boolean
  ): Promise<void> {
    const loadMemory = async () => import('@agent-relay/memory');

    try {
      const { createMemoryHooks } = await loadMemory();

      // Handle boolean config (true = use defaults)
      if (config === true || config === false) {
        if (!config) return; // false means disabled
        const hooks = createMemoryHooks({
          agentId: this.agentId,
          projectId: this.projectId,
        });
        this.registerLifecycleHooks(hooks);
        return;
      }

      // Handle object config
      const hooks = createMemoryHooks({
        config: {
          type: config.type,
          apiKey: config.apiKey,
          endpoint: config.endpoint,
        },
        agentId: this.agentId,
        projectId: this.projectId,
        injectOnStart: config.injectOnStart,
        maxStartMemories: config.maxStartMemories,
        promptOnEnd: config.promptOnEnd,
        autoSave: config.autoSave,
        autoSaveOnEnd: config.autoSaveOnEnd,
      });

      this.registerLifecycleHooks(hooks);
    } catch (error) {
      console.error('[hooks] Failed to register memory hooks:', error);
    }
  }

  /**
   * Register memory hooks with custom options
   */
  async registerMemoryHooks(options?: {
    type?: string;
    apiKey?: string;
    injectOnStart?: boolean;
    promptOnEnd?: boolean;
    autoSave?: boolean;
    autoSaveOnEnd?: boolean;
  }): Promise<void> {
    await this.registerMemoryHooksFromConfig(options ?? {});
  }

  /**
   * Register lifecycle hooks
   */
  registerLifecycleHooks(hooks: LifecycleHooks): void {
    if (hooks.onSessionStart) {
      this.addHooks('sessionStart', hooks.onSessionStart);
    }
    if (hooks.onSessionEnd) {
      this.addHooks('sessionEnd', hooks.onSessionEnd);
    }
    if (hooks.onOutput) {
      this.addHooks('output', hooks.onOutput);
    }
    if (hooks.onMessageReceived) {
      this.addHooks('messageReceived', hooks.onMessageReceived);
    }
    if (hooks.onMessageSent) {
      this.addHooks('messageSent', hooks.onMessageSent);
    }
    if (hooks.onIdle) {
      this.addHooks('idle', hooks.onIdle);
    }
    if (hooks.onError) {
      this.addHooks('error', hooks.onError);
    }
  }

  /**
   * Add hooks for a specific event
   */
  private addHooks(event: LifecycleHookEvent, hooks: unknown): void {
    const hookArray = Array.isArray(hooks) ? hooks : [hooks];

    switch (event) {
      case 'sessionStart':
        this.sessionStartHooks.push(...(hookArray as OnSessionStartHook[]));
        break;
      case 'sessionEnd':
        this.sessionEndHooks.push(...(hookArray as OnSessionEndHook[]));
        break;
      case 'output':
        this.outputHooks.push(...(hookArray as OnOutputHook[]));
        break;
      case 'messageReceived':
        this.messageReceivedHooks.push(...(hookArray as OnMessageReceivedHook[]));
        break;
      case 'messageSent':
        this.messageSentHooks.push(...(hookArray as OnMessageSentHook[]));
        break;
      case 'idle':
        this.idleHooks.push(...(hookArray as OnIdleHook[]));
        break;
      case 'error':
        this.errorHooks.push(...(hookArray as OnErrorHook[]));
        break;
    }
  }

  /**
   * Register a pattern handler
   */
  registerPattern(namespace: string, handler: PatternHandler): void {
    this.patternHandlers.set(namespace, handler);
  }

  /**
   * Get the base hook context
   */
  private getBaseContext(): HookContext {
    return {
      agentId: this.agentId,
      sessionId: this.sessionId,
      workingDir: this.workingDir,
      env: this.env,
      inject: (content: string) => {
        if (this.injectFn) {
          this.injectFn(content);
        }
      },
      send: async (to: string, body: string) => {
        if (this.sendFn) {
          await this.sendFn(to, body);
        }
      },
      memory: this.memory,
      relay: this.relay,
      output: [...this.outputHistory],
      messages: [...this.messageHistory],
    };
  }

  /**
   * Run hooks and collect results
   */
  private async runHooks<T extends HookContext>(
    hooks: Array<(ctx: T) => Promise<HookResult | void> | HookResult | void>,
    context: T
  ): Promise<HookResult> {
    const combinedResult: HookResult = {};

    for (const hook of hooks) {
      try {
        const result = await hook(context);
        if (result) {
          if (result.inject) {
            combinedResult.inject = (combinedResult.inject ?? '') + result.inject;
          }
          if (result.suppress) {
            combinedResult.suppress = true;
          }
          if (result.stop) {
            combinedResult.stop = true;
            break;
          }
        }
      } catch (err) {
        console.error('[hooks] Hook execution error:', err);
      }
    }

    // Execute injection if any
    if (combinedResult.inject && this.injectFn) {
      this.injectFn(combinedResult.inject);
    }

    return combinedResult;
  }

  /**
   * Dispatch session start event
   */
  async dispatchSessionStart(): Promise<HookResult> {
    this.sessionStartTime = Date.now();
    this.startIdleTimer();

    const context: SessionStartContext = {
      ...this.getBaseContext(),
      task: this.task,
      taskId: this.taskId,
      taskSource: this.taskSource,
    };

    return this.runHooks(this.sessionStartHooks, context);
  }

  /**
   * Dispatch session end event
   */
  async dispatchSessionEnd(exitCode?: number, graceful = true): Promise<HookResult> {
    this.stopIdleTimer();

    const context: SessionEndContext = {
      ...this.getBaseContext(),
      exitCode,
      duration: Date.now() - this.sessionStartTime,
      graceful,
    };

    return this.runHooks(this.sessionEndHooks, context);
  }

  /**
   * Dispatch output event
   */
  async dispatchOutput(content: string, rawContent: string, isComplete = true): Promise<HookResult> {
    this.resetIdleTimer();

    // Record in history
    this.outputHistory.push({
      type: 'text',
      content,
      timestamp: Date.now(),
    });

    const context: OutputContext = {
      ...this.getBaseContext(),
      content,
      rawContent,
      isComplete,
    };

    // Check for patterns
    await this.checkPatterns(content, context);

    return this.runHooks(this.outputHooks, context);
  }

  /**
   * Dispatch message received event
   */
  async dispatchMessageReceived(
    from: string,
    body: string,
    messageId: string,
    thread?: string
  ): Promise<HookResult> {
    this.resetIdleTimer();

    // Record in history
    this.messageHistory.push({
      role: 'user',
      content: `[${from}]: ${body}`,
      timestamp: Date.now(),
    });

    const context: MessageReceivedContext = {
      ...this.getBaseContext(),
      from,
      body,
      messageId,
      thread,
    };

    return this.runHooks(this.messageReceivedHooks, context);
  }

  /**
   * Dispatch message sent event
   */
  async dispatchMessageSent(to: string, body: string, thread?: string): Promise<HookResult> {
    this.resetIdleTimer();

    // Record in history
    this.messageHistory.push({
      role: 'assistant',
      content: `[to ${to}]: ${body}`,
      timestamp: Date.now(),
    });

    const context: MessageSentContext = {
      ...this.getBaseContext(),
      to,
      body,
      thread,
    };

    return this.runHooks(this.messageSentHooks, context);
  }

  /**
   * Dispatch idle event
   */
  async dispatchIdle(): Promise<HookResult> {
    this.idleCount++;

    const context: IdleContext = {
      ...this.getBaseContext(),
      idleDuration: Date.now() - this.lastActivityTime,
      idleCount: this.idleCount,
    };

    const result = await this.runHooks(this.idleHooks, context);

    // Restart idle timer
    this.startIdleTimer();

    return result;
  }

  /**
   * Dispatch error event
   */
  async dispatchError(error: Error, phase?: string): Promise<HookResult> {
    const context: ErrorContext = {
      ...this.getBaseContext(),
      error,
      phase,
    };

    return this.runHooks(this.errorHooks, context);
  }

  /**
   * Check content for pattern matches
   */
  private async checkPatterns(content: string, baseContext: HookContext): Promise<void> {
    // Match patterns like @namespace:target message
    const patternRegex = /@(\w+):(\S+)\s*(.*)/g;
    let match;

    while ((match = patternRegex.exec(content)) !== null) {
      const [, namespace, target, message] = match;
      const handler = this.patternHandlers.get(namespace);

      if (handler) {
        try {
          const result = await handler(target, message.trim(), baseContext);
          if (result?.inject && this.injectFn) {
            this.injectFn(result.inject);
          }
        } catch (err) {
          console.error(`[hooks] Pattern handler error for @${namespace}:`, err);
        }
      }
    }
  }

  /**
   * Start idle timer
   */
  private startIdleTimer(): void {
    this.stopIdleTimer();
    if (this.idleHooks.length > 0 && this.idleTimeout > 0) {
      this.idleTimer = setTimeout(() => {
        this.dispatchIdle().catch(console.error);
      }, this.idleTimeout);
    }
  }

  /**
   * Stop idle timer
   */
  private stopIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /**
   * Reset idle timer on activity
   */
  private resetIdleTimer(): void {
    this.lastActivityTime = Date.now();
    this.startIdleTimer();
  }

  /**
   * Get session info
   */
  getSessionInfo(): { sessionId: string; agentId: string; startTime: Date; duration: number } {
    return {
      sessionId: this.sessionId,
      agentId: this.agentId,
      startTime: new Date(this.sessionStartTime),
      duration: Date.now() - this.sessionStartTime,
    };
  }

  /**
   * Update inject function
   */
  setInjectFn(fn: (text: string) => void): void {
    this.injectFn = fn;
  }

  /**
   * Update send function
   */
  setSendFn(fn: (to: string, body: string) => Promise<void>): void {
    this.sendFn = fn;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stopIdleTimer();
    this.memory.clear();
    this.sessionStartHooks = [];
    this.sessionEndHooks = [];
    this.outputHooks = [];
    this.messageReceivedHooks = [];
    this.messageSentHooks = [];
    this.idleHooks = [];
    this.errorHooks = [];
    this.patternHandlers.clear();
  }
}
