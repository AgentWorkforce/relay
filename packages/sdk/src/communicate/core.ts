import { RelayTransport } from './transport.js';
import {
  type Message,
  type MessageCallback,
  type RelayConfig,
  resolveRelayConfig,
} from './types.js';

const MAX_PENDING_MESSAGES = 10_000;

/**
 * Core relay client for inter-agent communication.
 *
 * Lazily connects on first API call. Buffers incoming WebSocket messages
 * for {@link inbox} when no callbacks are registered.
 */
export class Relay {
  readonly agentName: string;
  readonly config;
  readonly transport: RelayTransport;

  private pending: Message[] = [];
  private callbacks = new Set<MessageCallback>();
  private connectPromise?: Promise<void>;
  private connected = false;
  private readonly exitHandler?: () => void;

  constructor(agentName: string, config: RelayConfig = {}) {
    this.agentName = agentName;
    this.config = resolveRelayConfig(config);
    this.transport = new RelayTransport(agentName, this.config);
    this.transport.onWsMessage((message) => this.handleTransportMessage(message));

    if (this.config.autoCleanup) {
      this.exitHandler = () => {
        void this.close();
      };
      process.once('beforeExit', this.exitHandler);
      process.once('SIGTERM', this.exitHandler);
      process.once('SIGINT', this.exitHandler);
    }
  }

  /**
   * Send a direct message to another agent.
   * @param to - Recipient agent name.
   * @param text - Message content.
   */
  async send(to: string, text: string): Promise<void> {
    await this.ensureConnected();
    await this.transport.sendDm(to, text);
  }

  /**
   * Post a message to a channel.
   * @param channel - Target channel name.
   * @param text - Message content.
   */
  async post(channel: string, text: string): Promise<void> {
    await this.ensureConnected();
    await this.transport.postMessage(channel, text);
  }

  /**
   * Reply to a specific message in a thread.
   * @param messageId - ID of the message to reply to.
   * @param text - Reply content.
   */
  async reply(messageId: string, text: string): Promise<void> {
    await this.ensureConnected();
    await this.transport.reply(messageId, text);
  }

  /**
   * Drain and return all buffered messages, clearing the buffer.
   * @returns Array of buffered messages.
   */
  async inbox(): Promise<Message[]> {
    await this.ensureConnected();
    const messages = [...this.pending];
    this.pending = [];
    return messages;
  }

  /**
   * Register a callback for incoming messages.
   * @param callback - Invoked for each received message.
   * @returns Unsubscribe function.
   */
  onMessage(callback: MessageCallback): () => void {
    this.callbacks.add(callback);
    void this.ensureConnected();

    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * List currently online agents.
   * @returns Array of agent names.
   */
  async agents(): Promise<string[]> {
    await this.ensureConnected();
    return this.transport.listAgents();
  }

  /** Unregister the agent, close the WebSocket, and clean up. */
  async close(): Promise<void> {
    if (this.exitHandler) {
      process.removeListener('beforeExit', this.exitHandler);
      process.removeListener('SIGTERM', this.exitHandler);
      process.removeListener('SIGINT', this.exitHandler);
    }

    this.connected = false;
    this.connectPromise = undefined;
    await this.transport.disconnect();
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.transport.connect().then(
        () => {
          this.connected = true;
        },
        (err) => {
          // Clear cached promise so the next call can retry
          this.connectPromise = undefined;
          throw err;
        },
      );
    }

    await this.connectPromise;
  }

  private async handleTransportMessage(message: Message): Promise<void> {
    // Always buffer the message (spec: "both" case — callbacks AND inbox)
    if (this.pending.length >= MAX_PENDING_MESSAGES) {
      this.pending.shift();
      process.emitWarning(
        'Relay pending buffer exceeded 10,000 messages; dropping oldest message.',
        'RelayWarning'
      );
    }
    this.pending.push(message);

    for (const callback of [...this.callbacks]) {
      await callback(message);
    }
  }
}
