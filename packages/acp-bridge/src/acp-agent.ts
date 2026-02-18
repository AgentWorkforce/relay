/**
 * ACP Agent Implementation
 *
 * Implements the ACP Agent interface to bridge relay agents to ACP clients.
 */

import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { AgentRelay, type Agent, type Message } from '@agent-relay/broker-sdk';
import type {
  ACPBridgeConfig,
  SessionState,
  RelayMessage,
  BridgePromptResult,
} from './types.js';

/**
 * Bounded circular cache for message deduplication.
 * Evicts oldest entries when capacity is reached to prevent unbounded memory growth.
 */
class CircularDedupeCache {
  private ids: Set<string> = new Set();
  private ring: string[];
  private head = 0;
  private readonly capacity: number;

  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.ring = new Array(capacity);
  }

  /**
   * Check if ID has been seen. Returns true if duplicate, false if new.
   * Automatically adds new IDs and evicts oldest when at capacity.
   */
  check(id: string): boolean {
    if (this.ids.has(id)) return true;

    if (this.ids.size >= this.capacity) {
      const oldest = this.ring[this.head];
      if (oldest) this.ids.delete(oldest);
    }

    this.ring[this.head] = id;
    this.ids.add(id);
    this.head = (this.head + 1) % this.capacity;

    return false;
  }

  clear(): void {
    this.ids.clear();
    this.ring = new Array(this.capacity);
    this.head = 0;
  }
}

/**
 * ACP Agent that bridges to Agent Relay
 */
export class RelayACPAgent implements acp.Agent {
  private static readonly RECONNECT_COOLDOWN_MS = 10_000;

  private readonly config: ACPBridgeConfig;
  private relay: AgentRelay | null = null;
  private connection: acp.AgentSideConnection | null = null;
  private sessions = new Map<string, SessionState>();
  private messageBuffer = new Map<string, RelayMessage[]>();
  private dedupeCache = new CircularDedupeCache(2000);
  private closedSessionIds = new Set<string>();
  private reconnectPromise: Promise<boolean> | null = null;
  private lastReconnectAttempt = 0;

  constructor(config: ACPBridgeConfig) {
    this.config = config;
    this.relay = this.createRelay();
  }

  /**
   * Start the ACP agent with stdio transport
   */
  async start(): Promise<void> {
    this.relay = this.relay ?? this.createRelay();
    this.setupRelayHandlers();

    try {
      await this.relay.getStatus();
      this.debug('Connected to relay broker via broker SDK');
    } catch (err) {
      this.debug('Failed to connect to relay broker via broker SDK:', err);
      // Continue anyway - we can still function without relay
    }

    // Create ACP connection over stdio using ndJsonStream
    const readable = this.nodeToWebReadable(process.stdin);
    const writable = this.nodeToWebWritable(process.stdout);
    const stream = acp.ndJsonStream(writable, readable);

    // Create connection with agent factory
    this.connection = new acp.AgentSideConnection((conn) => {
      // Store connection reference for later use
      this.connection = conn;
      return this;
    }, stream);

    this.debug('ACP agent started');

    // Keep alive by waiting for connection to close
    await this.connection.closed;
  }

  /**
   * Stop the agent
   */
  async stop(): Promise<void> {
    // Clean up all sessions to prevent memory leaks
    this.sessions.clear();
    this.messageBuffer.clear();
    this.dedupeCache.clear();
    this.closedSessionIds.clear();

    try {
      await this.relay?.shutdown();
    } catch (err) {
      this.debug('Error during relay shutdown:', err);
    }
    this.relay = null;
    this.connection = null;
    this.debug('ACP agent stopped');
  }

  /**
   * Create a relay facade configured for this ACP bridge.
   */
  private createRelay(): AgentRelay {
    return new AgentRelay({
      brokerName: this.config.agentName,
      channels: ['general'],
    });
  }

  /**
   * Wire up relay message handlers.
   */
  private setupRelayHandlers(): void {
    if (!this.relay) return;

    this.relay.onMessageReceived = (msg: Message) => {
      this.handleRelayMessage({
        id: msg.eventId,
        from: msg.from,
        body: msg.text,
        thread: msg.threadId,
        timestamp: Date.now(),
      });
    };
  }

  /**
   * Attempt to reconnect to the relay broker with a fresh AgentRelay instance.
   */
  private async reconnectToRelay(): Promise<boolean> {
    this.debug('Attempting to reconnect to relay broker...');

    if (this.relay) {
      try {
        await this.relay.shutdown();
      } catch (err) {
        this.debug('Error shutting down stale relay instance:', err);
      }
    }

    this.relay = this.createRelay();
    this.setupRelayHandlers();

    try {
      await this.relay.getStatus();
      this.debug('Reconnected to relay broker');
      return true;
    } catch (err) {
      this.debug('Failed to reconnect to relay broker:', err);
      return false;
    }
  }

  /**
   * Ensure relay is responsive. Recreate relay instance if the broker is unavailable.
   */
  private async ensureRelayReady(): Promise<boolean> {
    if (!this.relay) {
      return this.reconnectToRelay();
    }

    try {
      await this.relay.getStatus();
      return true;
    } catch (err) {
      this.debug('Relay status check failed:', err);
    }

    // Deduplicate concurrent reconnect attempts
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }

    // Enforce cooldown to avoid rapid reconnect attempts
    const elapsed = Date.now() - this.lastReconnectAttempt;
    if (elapsed < RelayACPAgent.RECONNECT_COOLDOWN_MS) {
      return false;
    }

    this.lastReconnectAttempt = Date.now();
    this.reconnectPromise = this.reconnectToRelay().finally(() => {
      this.reconnectPromise = null;
    });
    return this.reconnectPromise;
  }

  /**
   * Close a specific session and clean up its resources
   */
  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.messageBuffer.delete(sessionId);
    // Track closed session IDs to distinguish from arbitrary thread names
    this.closedSessionIds.add(sessionId);
    this.debug('Closed session:', sessionId);
  }

  // =========================================================================
  // ACP Agent Interface Implementation
  // =========================================================================

  /**
   * Initialize the agent connection
   */
  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: this.config.capabilities?.supportsSessionLoading ?? false,
      },
    };
  }

  /**
   * Authenticate with the client (no auth required for relay)
   */
  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  /**
   * Create a new session
   */
  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    const session: SessionState = {
      id: sessionId,
      createdAt: new Date(),
      messages: [],
      isProcessing: false,
    };

    this.sessions.set(sessionId, session);

    // Initialize buffer with any pending messages that arrived before session existed
    const pendingMessages = this.messageBuffer.get('__pending__') || [];
    this.messageBuffer.set(sessionId, [...pendingMessages]);
    if (pendingMessages.length > 0) {
      this.messageBuffer.delete('__pending__');
      this.debug('Moved', pendingMessages.length, 'pending messages to new session');
    }

    this.debug('Created new session:', sessionId);

    // Show quick help in the editor panel
    await this.sendTextUpdate(sessionId, this.getHelpText());

    return { sessionId };
  }

  /**
   * Load an existing session (not supported)
   */
  async loadSession(_params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    throw new Error('Session loading not supported');
  }

  /**
   * Set session mode (optional)
   */
  async setSessionMode(_params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse | void> {
    // Mode changes not implemented
    return {};
  }

  /**
   * Handle a prompt from the client
   */
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    if (session.isProcessing) {
      throw new Error('Session is already processing a prompt');
    }

    session.isProcessing = true;
    session.abortController = new AbortController();

    // Note: __pending__ is drained in newSession() when session is created.
    // We don't drain here to avoid race conditions with multi-session scenarios
    // where multiple ACP clients (e.g., multiple Zed windows) are connected.

    try {
      // Extract text content from the prompt
      const userMessage = this.extractTextContent(params.prompt);

      // Add to session history
      session.messages.push({
        role: 'user',
        content: userMessage,
        timestamp: new Date(),
      });

      // Handle agent-relay CLI-style commands locally before broadcasting
      const handled = await this.tryHandleCliCommand(userMessage, params.sessionId);
      if (handled) {
        return { stopReason: 'end_turn' };
      }

      // Send to relay agents
      const result = await this.bridgeToRelay(
        session,
        userMessage,
        params.sessionId,
        session.abortController.signal
      );

      if (result.stopReason === 'cancelled') {
        return { stopReason: 'cancelled' };
      }

      return { stopReason: 'end_turn' };
    } finally {
      session.isProcessing = false;
      session.abortController = undefined;
    }
  }

  /**
   * Cancel the current operation
   */
  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session?.abortController) {
      session.abortController.abort();
    }
  }

  // =========================================================================
  // Relay Bridge Logic
  // =========================================================================

  /**
   * Parse @mentions from a message.
   * Returns { targets: string[], message: string } where targets are agent names
   * and message is the text with @mentions removed.
   *
   * Examples:
   *   "@Worker hello" -> { targets: ["Worker"], message: "hello" }
   *   "@Worker @Reviewer review this" -> { targets: ["Worker", "Reviewer"], message: "review this" }
   *   "hello everyone" -> { targets: [], message: "hello everyone" }
   */
  private parseAtMentions(text: string): { targets: string[]; message: string } {
    const mentionRegex = /@(\w+)/g;
    const targets: string[] = [];
    let match;

    while ((match = mentionRegex.exec(text)) !== null) {
      targets.push(match[1]);
    }

    // Remove @mentions from message
    const message = text.replace(/@\w+\s*/g, '').trim();

    return { targets, message: message || text };
  }

  /**
   * Bridge a user prompt to relay agents and collect responses
   */
  private async bridgeToRelay(
    session: SessionState,
    userMessage: string,
    sessionId: string,
    signal: AbortSignal
  ): Promise<BridgePromptResult> {
    if (!this.connection) {
      return {
        success: false,
        stopReason: 'error',
        responses: [],
        error: 'No ACP connection',
      };
    }

    if (!await this.ensureRelayReady()) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Agent Relay broker is not connected. Please ensure the relay broker is running.',
          },
        },
      });
      return {
        success: false,
        stopReason: 'end_turn',
        responses: [],
      };
    }

    const responses: RelayMessage[] = [];

    // First, stream any pending messages that arrived before this prompt
    const existingMessages = this.messageBuffer.get(session.id) || [];
    if (existingMessages.length > 0) {
      for (const msg of existingMessages) {
        await this.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `**${msg.from}** (earlier): ${msg.body}\n\n`,
            },
          },
        });
      }
    }

    // Clear buffer for new responses
    this.messageBuffer.set(session.id, []);

    // Parse @mentions to target specific agents
    const { targets, message: cleanMessage } = this.parseAtMentions(userMessage);
    const hasTargets = targets.length > 0;

    // Send "thinking" indicator with target info
    const targetInfo = hasTargets
      ? `Sending to ${targets.map(t => `@${t}`).join(', ')}...\n\n`
      : 'Broadcasting to all agents...\n\n';

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: targetInfo,
        },
      },
    });

    // Send to specific agents or broadcast
    const relay = this.relay!;
    const human = relay.human({ name: this.config.agentName });
    let sentCount = 0;
    if (hasTargets) {
      // Send to each mentioned agent
      for (const target of targets) {
        try {
          await human.sendMessage({
            to: target,
            text: cleanMessage,
            threadId: session.id,
          });
          sentCount += 1;
        } catch (err) {
          this.debug(`Failed to send message to @${target}:`, err);
        }
      }
    } else {
      try {
        await human.sendMessage({
          to: '*',
          text: userMessage,
          threadId: session.id,
        });
        sentCount = 1;
      } catch (err) {
        this.debug('Failed to broadcast message:', err);
      }
    }

    if (sentCount === 0) {
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Failed to send message to relay agents. Please check the relay daemon connection.',
          },
        },
      });

      return {
        success: false,
        stopReason: 'error',
        responses,
      };
    }

    // Wait for responses with timeout
    const responseTimeout = 30000; // 30 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < responseTimeout) {
      if (signal.aborted) {
        return {
          success: false,
          stopReason: 'cancelled',
          responses,
        };
      }

      // Check for new messages in buffer
      const newMessages = this.messageBuffer.get(session.id) || [];
      if (newMessages.length > 0) {
        responses.push(...newMessages);
        this.messageBuffer.set(session.id, []);

        // Stream each response as it arrives
        for (const msg of newMessages) {
          await this.connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `**${msg.from}**: ${msg.body}\n\n`,
              },
            },
          });

          // Add to session history
          session.messages.push({
            role: 'assistant',
            content: msg.body,
            timestamp: new Date(msg.timestamp),
            fromAgent: msg.from,
          });
        }
      }

      // Small delay to prevent busy waiting
      await this.sleep(100);

      // If we have responses and nothing new for 2 seconds, consider it done
      if (responses.length > 0) {
        const lastMessage = responses[responses.length - 1];
        if (Date.now() - lastMessage.timestamp > 2000) {
          break;
        }
      }
    }

    return {
      success: true,
      stopReason: 'end_turn',
      responses,
    };
  }

  /**
   * Handle incoming relay messages
   */
  private handleRelayMessage(message: RelayMessage): void {
    this.debug('Received relay message:', message.from, message.body.substring(0, 50));

    // Deduplicate messages by ID (same message may arrive via multiple routes)
    // Uses bounded cache to prevent unbounded memory growth in long-running sessions
    if (this.dedupeCache.check(message.id)) {
      this.debug('Skipping duplicate message:', message.id);
      return;
    }

    // Check for system messages (crash notifications, etc.)
    if (message.data?.isSystemMessage) {
      this.handleSystemMessage(message);
      return;
    }

    // Route to appropriate session based on thread
    if (message.thread) {
      const buffer = this.messageBuffer.get(message.thread);
      if (buffer) {
        buffer.push(message);
        return;
      }
      // Only drop if thread was a known ACP session that is now closed.
      // Arbitrary thread names (e.g., "code-review") should fall through to broadcast.
      if (this.closedSessionIds.has(message.thread)) {
        this.debug('Dropping message for closed session thread:', message.thread);
        return;
      }
      // Thread is not a known session ID - fall through to broadcast to all sessions
      this.debug('Unknown thread, broadcasting:', message.thread);
    }

    // Add to all sessions - active ones immediately, idle ones will see on next prompt
    // This ensures async messages from spawned agents aren't dropped
    let addedToAny = false;
    for (const [sessionId] of this.sessions) {
      const buffer = this.messageBuffer.get(sessionId) || [];
      buffer.push(message);
      this.messageBuffer.set(sessionId, buffer);
      addedToAny = true;
    }

    // If no sessions exist yet, store in a bounded pending queue
    // Cap at 500 messages to prevent unbounded memory growth
    if (!addedToAny) {
      const pending = this.messageBuffer.get('__pending__') || [];
      pending.push(message);
      // Evict oldest messages if queue exceeds max size
      const maxPendingSize = 500;
      while (pending.length > maxPendingSize) {
        pending.shift();
      }
      this.messageBuffer.set('__pending__', pending);
    }
  }

  /**
   * Handle system messages (crash notifications, etc.)
   * These are displayed to all sessions regardless of processing state.
   */
  private handleSystemMessage(message: RelayMessage): void {
    const data = message.data || {};

    // Format crash notifications nicely
    if (data.crashType) {
      const agentName = data.agentName || message.from || 'Unknown agent';
      const signal = data.signal ? ` (${data.signal})` : '';
      const exitCode = data.exitCode !== undefined ? ` [exit code: ${data.exitCode}]` : '';

      const crashNotification = [
        '',
        `⚠️ **Agent Crashed**: \`${agentName}\`${signal}${exitCode}`,
        '',
        message.body,
        '',
      ].join('\n');

      // Send to all sessions (not just processing ones)
      this.broadcastToAllSessions(crashNotification);
    } else {
      // Generic system message
      this.broadcastToAllSessions(`**System**: ${message.body}`);
    }
  }

  /**
   * Broadcast a message to all active sessions.
   */
  private broadcastToAllSessions(text: string): void {
    for (const [sessionId] of this.sessions) {
      this.sendTextUpdate(sessionId, text).catch((err) => {
        this.debug('Failed to send broadcast to session:', sessionId, err);
      });
    }
  }

  // =========================================================================
  // CLI Command Handling (Zed Agent Panel)
  // =========================================================================

  /**
   * Parse and handle agent-relay CLI-style commands coming from the editor.
   */
  private async tryHandleCliCommand(userMessage: string, sessionId: string): Promise<boolean> {
    const tokens = this.parseCliArgs(userMessage);
    if (tokens.length === 0) {
      return false;
    }

    let command = tokens[0];
    let args = tokens.slice(1);

    // Support "agent-relay ..." and "relay ..." prefixes
    if (command === 'agent-relay' || command === 'relay') {
      if (args.length === 0) return false;
      command = args[0];
      args = args.slice(1);
    } else if (command === 'create' && args[0] === 'agent') {
      command = 'spawn';
      args = args.slice(1);
    }

    switch (command) {
      case 'spawn':
      case 'create-agent':
        return this.handleSpawnCommand(args, sessionId);
      case 'release':
        return this.handleReleaseCommand(args, sessionId);
      case 'agents':
      case 'who':
        return this.handleListAgentsCommand(sessionId);
      case 'status':
        return this.handleStatusCommand(sessionId);
      case 'help':
        await this.sendTextUpdate(sessionId, this.getHelpText());
        return true;
      default:
        return false;
    }
  }

  private async handleSpawnCommand(args: string[], sessionId: string): Promise<boolean> {
    const [name, cli, ...taskParts] = args;
    if (!name || !cli) {
      await this.sendTextUpdate(sessionId, 'Usage: agent-relay spawn <name> <cli> "<task>"');
      return true;
    }

    if (!await this.ensureRelayReady()) {
      await this.sendTextUpdate(sessionId, 'Relay broker is not connected (cannot spawn).');
      return true;
    }

    const task = taskParts.join(' ').trim() || undefined;
    await this.sendTextUpdate(sessionId, `Spawning ${name} (${cli})${task ? `: ${task}` : ''}`);

    try {
      const relay = this.relay!;
      const agent = await relay.spawnPty({
        name,
        cli,
        task,
      });
      try {
        await relay.waitForAgentReady(name, 60_000);
        await this.sendTextUpdate(sessionId, `Spawned ${agent.name} (ready).`);
      } catch (readyErr) {
        await this.sendTextUpdate(
          sessionId,
          `Spawned ${agent.name}, but it did not report ready within 60s: ${(readyErr as Error).message}`
        );
      }
    } catch (err) {
      await this.sendTextUpdate(sessionId, `Spawn error for ${name}: ${(err as Error).message}`);
    }

    return true;
  }

  private async handleReleaseCommand(args: string[], sessionId: string): Promise<boolean> {
    const [name] = args;
    if (!name) {
      await this.sendTextUpdate(sessionId, 'Usage: agent-relay release <name>');
      return true;
    }

    if (!await this.ensureRelayReady()) {
      await this.sendTextUpdate(sessionId, 'Relay broker is not connected (cannot release).');
      return true;
    }

    await this.sendTextUpdate(sessionId, `Releasing ${name}...`);

    try {
      const relay = this.relay!;
      const agents: Agent[] = await relay.listAgents();
      const agent = agents.find((entry) => entry.name === name);
      if (!agent) {
        await this.sendTextUpdate(sessionId, `Failed to release ${name}: agent not found.`);
        return true;
      }
      await agent.release();
      await this.sendTextUpdate(sessionId, `Released ${name}.`);
    } catch (err) {
      await this.sendTextUpdate(sessionId, `Release error for ${name}: ${(err as Error).message}`);
    }

    return true;
  }

  private async handleListAgentsCommand(sessionId: string): Promise<boolean> {
    if (!await this.ensureRelayReady()) {
      await this.sendTextUpdate(sessionId, 'Relay broker is not connected (cannot list agents).');
      return true;
    }

    try {
      const agents = await this.relay!.listAgents();
      if (!agents.length) {
        await this.sendTextUpdate(sessionId, 'No agents are currently connected.');
      } else {
        const lines = agents.map((agent) => `- ${agent.name} (${agent.runtime})`);
        await this.sendTextUpdate(sessionId, ['Connected agents:', ...lines].join('\n'));
      }
    } catch (err) {
      await this.sendTextUpdate(sessionId, `Failed to list agents: ${(err as Error).message}`);
    }

    return true;
  }

  private async handleStatusCommand(sessionId: string): Promise<boolean> {
    const lines: string[] = ['Agent Relay Status', ''];

    if (!this.relay) {
      lines.push('Relay client: Not initialized');
      await this.sendTextUpdate(sessionId, lines.join('\n'));
      return true;
    }

    const isConnected = await this.ensureRelayReady();
    lines.push(`Connection: ${isConnected ? 'Connected' : 'Disconnected'}`);
    lines.push(`Agent name: ${this.config.agentName}`);

    if (isConnected) {
      try {
        const status = await this.relay.getStatus();
        lines.push(`Connected agents: ${status.agent_count}`);
        lines.push(`Pending deliveries: ${status.pending_delivery_count}`);
      } catch (err) {
        lines.push(`Status details unavailable: ${(err as Error).message}`);
      }
    }

    await this.sendTextUpdate(sessionId, lines.join('\n'));
    return true;
  }

  private async sendTextUpdate(sessionId: string, text: string): Promise<void> {
    if (!this.connection) return;

    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text,
        },
      },
    });
  }

  private parseCliArgs(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let inQuote: '"' | "'" | null = null;
    let escape = false;

    for (const char of input.trim()) {
      if (escape) {
        current += char;
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        continue;
      }

      if (inQuote) {
        if (char === inQuote) {
          inQuote = null;
        } else {
          current += char;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inQuote = char;
        continue;
      }

      if (/\s/.test(char)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }

      current += char;
    }

    if (current) {
      args.push(current);
    }

    return args;
  }

  private getHelpText(): string {
    return [
      'Agent Relay (Zed)',
      '',
      'Commands:',
      '- agent-relay spawn <name> <cli> "task"',
      '- agent-relay release <name>',
      '- agent-relay agents',
      '- agent-relay status',
      '- agent-relay help',
      '',
      'Other messages are broadcast to connected agents.',
    ].join('\n');
  }

  // =========================================================================
  // Utility Methods
  // =========================================================================

  /**
   * Extract text content from ACP content blocks
   */
  private extractTextContent(content: acp.ContentBlock[]): string {
    return content
      .filter((block): block is acp.ContentBlock & { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  /**
   * Convert Node.js readable stream to Web ReadableStream
   */
  private nodeToWebReadable(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        nodeStream.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
        });
        nodeStream.on('end', () => {
          controller.close();
        });
        nodeStream.on('error', (err) => {
          controller.error(err);
        });
      },
    });
  }

  /**
   * Convert Node.js writable stream to Web WritableStream
   */
  private nodeToWebWritable(nodeStream: NodeJS.WritableStream): WritableStream<Uint8Array> {
    return new WritableStream({
      write(chunk) {
        return new Promise((resolve, reject) => {
          nodeStream.write(Buffer.from(chunk), (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      close() {
        return new Promise((resolve) => {
          nodeStream.end(() => resolve());
        });
      },
    });
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Debug logging
   */
  private debug(...args: unknown[]): void {
    if (this.config.debug) {
      console.error('[RelayACPAgent]', ...args);
    }
  }
}
