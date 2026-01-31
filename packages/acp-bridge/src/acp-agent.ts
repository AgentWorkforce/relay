/**
 * ACP Agent Implementation
 *
 * Implements the ACP Agent interface to bridge relay agents to ACP clients.
 */

import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { RelayClient, type RelayClientConfig } from './relay-client.js';
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
    const socketPath = this.config.socketPath || this.getDefaultSocketPath();
    this.relayClient = new RelayClient({
      agentName: this.config.agentName,
      socketPath,
      debug: this.config.debug,
    });

    try {
      await this.relayClient.connect();
      this.debug('Connected to relay daemon');
    } catch (err) {
      this.debug('Failed to connect to relay daemon:', err);
      // Continue anyway - we can still function without relay
    }

    // Set up message handler
    if (this.relayClient) {
      this.relayClient.onMessage((message) => this.handleRelayMessage(message));
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
    this.relayClient?.disconnect();
    this.connection = null;
    this.debug('ACP agent stopped');
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

    if (!this.relayClient?.isConnected()) {
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

    // Send "thinking" indicator
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Sending to relay agents...\n\n',
        },
      },
    });

    // Broadcast to all relay agents
    await this.relayClient.broadcast(userMessage, {
      thread: session.id,
    });

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
   * Get default socket path based on environment
   */
  private getDefaultSocketPath(): string {
    const workspaceId = process.env.WORKSPACE_ID;
    if (workspaceId) {
      return `/tmp/relay/${workspaceId}/sockets/daemon.sock`;
    }
    return '/tmp/relay-daemon.sock';
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
