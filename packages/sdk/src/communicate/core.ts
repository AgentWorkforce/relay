import { RelayTransport } from './transport.js';
import {
  type Message,
  type MessageCallback,
  type RelayConfig,
  resolveRelayConfig,
} from './types.js';

const MAX_PENDING_MESSAGES = 10_000;

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
    }
  }

  async send(to: string, text: string): Promise<void> {
    await this.ensureConnected();
    await this.transport.sendDm(to, text);
  }

  async post(channel: string, text: string): Promise<void> {
    await this.ensureConnected();
    await this.transport.postMessage(channel, text);
  }

  async reply(messageId: string, text: string): Promise<void> {
    await this.ensureConnected();
    await this.transport.reply(messageId, text);
  }

  async inbox(): Promise<Message[]> {
    await this.ensureConnected();
    const messages = [...this.pending];
    this.pending = [];
    return messages;
  }

  onMessage(callback: MessageCallback): () => void {
    this.callbacks.add(callback);
    void this.ensureConnected();

    return () => {
      this.callbacks.delete(callback);
    };
  }

  async agents(): Promise<string[]> {
    await this.ensureConnected();
    return this.transport.listAgents();
  }

  async close(): Promise<void> {
    if (this.exitHandler) {
      process.removeListener('beforeExit', this.exitHandler);
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
      this.connectPromise = this.transport.connect().then(() => {
        this.connected = true;
      });
    }

    await this.connectPromise;
  }

  private async handleTransportMessage(message: Message): Promise<void> {
    if (this.callbacks.size === 0) {
      if (this.pending.length >= MAX_PENDING_MESSAGES) {
        this.pending.shift();
        process.emitWarning(
          'Relay pending buffer exceeded 10,000 messages; dropping oldest message.',
          'RelayWarning'
        );
      }
      this.pending.push(message);
      return;
    }

    for (const callback of [...this.callbacks]) {
      await callback(message);
    }
  }
}
