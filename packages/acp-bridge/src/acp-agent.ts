/**
 * ACP Agent Implementation
 *
 * Implements the ACP Agent interface to bridge relay agents to ACP clients.
 */

import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { RelayClient, type ClientConfig } from '@agent-relay/sdk';
import type {
  ACPBridgeConfig,
  SessionState,
  RelayMessage,
  BridgePromptResult,
} from './types.js';

/**
 * ACP Agent that bridges to Agent Relay
 */
export class RelayACPAgent implements acp.Agent {
  private readonly config: ACPBridgeConfig;
  private relayClient: RelayClient | null = null;
  private connection: acp.AgentSideConnection | null = null;
  private sessions = new Map<string, SessionState>();
  private messageBuffer = new Map<string, RelayMessage[]>();

  constructor(config: ACPBridgeConfig) {
    this.config = config;
  }

  /**
   * Start the ACP agent with stdio transport
   */
  async start(): Promise<void> {
    // Connect to relay daemon
    const relayConfig: Partial<ClientConfig> = {
      agentName: this.config.agentName,
      program: '@agent-relay/acp-bridge',
      cli: 'acp-bridge',
      quiet: true,
    };

    if (this.config.socketPath) {
      relayConfig.socketPath = this.config.socketPath;
    }

    this.relayClient = new RelayClient(relayConfig);

    // Set up message handlers
    this.relayClient.onMessage = (from, payload, messageId) => {
      if (typeof payload.body !== 'string') {
        return;
      }

      this.handleRelayMessage({
        id: messageId,
        from,
        body: payload.body,
        thread: payload.thread,
        timestamp: Date.now(),
        data: payload.data as Record<string, unknown> | undefined,
      });
    };

    // Handle channel messages (e.g., #general)
    this.relayClient.onChannelMessage = (from, channel, body) => {
      this.debug('Received channel message:', from, channel, body.substring(0, 50));

      // Route channel messages to all sessions
      this.handleRelayMessage({
        id: `channel-${Date.now()}`,
        from: `${from} [${channel}]`,
        body,
        timestamp: Date.now(),
      });
    };

    this.relayClient.onStateChange = (state) => {
      this.debug('Relay client state:', state);
    };

    this.relayClient.onError = (error) => {
      this.debug('Relay client error:', error);
    };

    try {
      await this.relayClient.connect();
      this.debug('Connected to relay daemon via SDK');

      // Subscribe to #general channel to receive broadcast messages
      this.relayClient.subscribe('#general');
      this.debug('Subscribed to #general channel');
    } catch (err) {
      this.debug('Failed to connect to relay daemon via SDK:', err);
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

    this.relayClient?.destroy();
    this.relayClient = null;
    this.connection = null;
    this.debug('ACP agent stopped');
  }

  /**
   * Close a specific session and clean up its resources
   */
  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.messageBuffer.delete(sessionId);
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
    this.messageBuffer.set(sessionId, []);

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

    if (!this.relayClient || this.relayClient.state !== 'READY') {
      // If not connected to relay, return a helpful message
      await this.connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Agent Relay daemon is not connected. Please ensure the relay daemon is running.',
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

    // Clear buffer
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
    let sent = false;
    if (hasTargets) {
      // Send to each mentioned agent
      for (const target of targets) {
        const result = this.relayClient.sendMessage(target, cleanMessage, 'message', undefined, session.id);
        if (result) sent = true;
      }
    } else {
      // Broadcast to all agents
      sent = this.relayClient.sendMessage('*', userMessage, 'message', undefined, session.id);
    }

    if (!sent) {
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
    }

    // If no specific session, add to all active sessions
    for (const [sessionId, session] of this.sessions) {
      if (session.isProcessing) {
        const buffer = this.messageBuffer.get(sessionId) || [];
        buffer.push(message);
        this.messageBuffer.set(sessionId, buffer);
      }
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

    if (!this.relayClient || this.relayClient.state !== 'READY') {
      await this.sendTextUpdate(sessionId, 'Relay daemon is not connected (cannot spawn).');
      return true;
    }

    const task = taskParts.join(' ').trim() || undefined;
    await this.sendTextUpdate(sessionId, `Spawning ${name} (${cli})${task ? `: ${task}` : ''}`);

    try {
      const result = await this.relayClient.spawn({
        name,
        cli,
        task,
        waitForReady: true,
      });

      if (result.success) {
        const readyText = result.ready ? ' (ready)' : '';
        await this.sendTextUpdate(sessionId, `Spawned ${name}${readyText}.`);
      } else {
        await this.sendTextUpdate(sessionId, `Failed to spawn ${name}: ${result.error || 'unknown error'}`);
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

    if (!this.relayClient || this.relayClient.state !== 'READY') {
      await this.sendTextUpdate(sessionId, 'Relay daemon is not connected (cannot release).');
      return true;
    }

    await this.sendTextUpdate(sessionId, `Releasing ${name}...`);

    try {
      const result = await this.relayClient.release(name);
      if (result.success) {
        await this.sendTextUpdate(sessionId, `Released ${name}.`);
      } else {
        await this.sendTextUpdate(sessionId, `Failed to release ${name}: ${result.error || 'unknown error'}`);
      }
    } catch (err) {
      await this.sendTextUpdate(sessionId, `Release error for ${name}: ${(err as Error).message}`);
    }

    return true;
  }

  private async handleListAgentsCommand(sessionId: string): Promise<boolean> {
    if (!this.relayClient || this.relayClient.state !== 'READY') {
      await this.sendTextUpdate(sessionId, 'Relay daemon is not connected (cannot list agents).');
      return true;
    }

    try {
      const agents = await this.relayClient.listConnectedAgents();
      if (!agents.length) {
        await this.sendTextUpdate(sessionId, 'No agents are currently connected.');
      } else {
        const lines = agents.map((agent) => `- ${agent.name}${agent.cli ? ` (${agent.cli})` : ''}`);
        await this.sendTextUpdate(sessionId, ['Connected agents:', ...lines].join('\n'));
      }
    } catch (err) {
      await this.sendTextUpdate(sessionId, `Failed to list agents: ${(err as Error).message}`);
    }

    return true;
  }

  private async handleStatusCommand(sessionId: string): Promise<boolean> {
    const lines: string[] = ['Agent Relay Status', ''];

    if (!this.relayClient) {
      lines.push('Relay client: Not initialized');
      await this.sendTextUpdate(sessionId, lines.join('\n'));
      return true;
    }

    const state = this.relayClient.state;
    const isConnected = state === 'READY';

    lines.push(`Connection: ${isConnected ? 'Connected' : 'Disconnected'}`);
    lines.push(`State: ${state}`);
    lines.push(`Agent name: ${this.config.agentName}`);

    if (isConnected) {
      // Try to get connected agents count
      try {
        const agents = await this.relayClient.listConnectedAgents();
        lines.push(`Connected agents: ${agents.length}`);
      } catch {
        // Ignore errors when listing agents
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
