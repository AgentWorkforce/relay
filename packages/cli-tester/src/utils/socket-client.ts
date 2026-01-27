/**
 * Socket client for communicating with relay-pty Unix socket
 * Used for programmatic message injection and status queries
 */

import { createConnection, Socket } from 'node:net';
import { createInterface } from 'node:readline';

export interface InjectRequest {
  type: 'inject';
  id: string;
  from: string;
  body: string;
  priority?: number;
}

export interface StatusRequest {
  type: 'status';
}

export interface InjectResponse {
  type: 'inject_result';
  id: string;
  status: 'queued' | 'injecting' | 'delivered' | 'failed';
  timestamp: number;
  error?: string;
}

export interface StatusResponse {
  type: 'status';
  agent_idle: boolean;
  queue_length: number;
  cursor_position: { row: number; col: number } | null;
  last_output_ms: number;
}

export type RelayPtyResponse = InjectResponse | StatusResponse;

export class RelayPtyClient {
  private socket: Socket | null = null;
  private socketPath: string;
  private responseBuffer: string = '';

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Connect to the relay-pty socket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath, () => {
        resolve();
      });

      this.socket.on('error', (err) => {
        reject(new Error(`Failed to connect to ${this.socketPath}: ${err.message}`));
      });

      this.socket.on('data', (data) => {
        this.responseBuffer += data.toString();
      });
    });
  }

  /**
   * Send a request and wait for response
   */
  private async sendRequest<T extends RelayPtyResponse>(request: object): Promise<T> {
    if (!this.socket) {
      throw new Error('Not connected. Call connect() first.');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timed out'));
      }, 10000);

      // Clear buffer before sending
      this.responseBuffer = '';

      // Set up response handler
      const checkResponse = () => {
        const lines = this.responseBuffer.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line) as T;
              clearTimeout(timeout);
              resolve(response);
              return;
            } catch {
              // Not valid JSON yet, keep waiting
            }
          }
        }
        // Keep checking
        setTimeout(checkResponse, 50);
      };

      // Send request
      const requestStr = JSON.stringify(request) + '\n';
      this.socket!.write(requestStr, (err) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
        } else {
          checkResponse();
        }
      });
    });
  }

  /**
   * Inject a message into the CLI
   */
  async inject(message: {
    from: string;
    body: string;
    priority?: number;
  }): Promise<InjectResponse> {
    const request: InjectRequest = {
      type: 'inject',
      id: `ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: message.from,
      body: message.body,
      priority: message.priority ?? 0,
    };

    return this.sendRequest<InjectResponse>(request);
  }

  /**
   * Get current status of the CLI session
   */
  async getStatus(): Promise<StatusResponse> {
    const request: StatusRequest = { type: 'status' };
    return this.sendRequest<StatusResponse>(request);
  }

  /**
   * Wait for a specific message to be delivered
   * Returns when the message reaches 'delivered' or 'failed' status
   */
  async waitForDelivered(
    messageId: string,
    timeoutMs: number = 30000
  ): Promise<InjectResponse> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const checkBuffer = () => {
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Timeout waiting for message ${messageId} to be delivered`));
          return;
        }

        const lines = this.responseBuffer.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line) as InjectResponse;
              if (
                response.type === 'inject_result' &&
                response.id === messageId &&
                (response.status === 'delivered' || response.status === 'failed')
              ) {
                resolve(response);
                return;
              }
            } catch {
              // Not valid JSON, skip
            }
          }
        }

        // Keep checking
        setTimeout(checkBuffer, 100);
      };

      checkBuffer();
    });
  }

  /**
   * Close the connection
   */
  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

/**
 * Helper to create a connected client
 */
export async function createClient(socketPath: string): Promise<RelayPtyClient> {
  const client = new RelayPtyClient(socketPath);
  await client.connect();
  return client;
}

/**
 * Get socket path for a named session
 */
export function getSocketPath(sessionName: string): string {
  return `/tmp/relay-pty-${sessionName}.sock`;
}
