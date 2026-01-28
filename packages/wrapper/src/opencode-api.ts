/**
 * OpenCode HTTP API client
 *
 * Provides integration with opencode serve's HTTP API for:
 * - Injecting text into the TUI input field (append-prompt)
 * - Submitting prompts
 * - Clearing prompts
 * - Session management
 *
 * @see https://github.com/anomalyco/opencode
 */

export interface OpenCodeApiConfig {
  /** Base URL for opencode serve (default: http://localhost:4096) */
  baseUrl?: string;
  /** Server password if authentication is enabled (OPENCODE_SERVER_PASSWORD) */
  password?: string;
  /** Request timeout in milliseconds (default: 5000) */
  timeout?: number;
}

export interface OpenCodeSession {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenCodeApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * OpenCode HTTP API client for interacting with opencode serve
 */
export class OpenCodeApi {
  private baseUrl: string;
  private password?: string;
  private timeout: number;

  constructor(config: OpenCodeApiConfig = {}) {
    // Priority: explicit config > OPENCODE_API_URL env > OPENCODE_PORT env > default
    const defaultPort = process.env.OPENCODE_PORT ?? '4096';
    const defaultUrl = process.env.OPENCODE_API_URL ?? `http://localhost:${defaultPort}`;
    this.baseUrl = config.baseUrl ?? defaultUrl;
    this.password = config.password ?? process.env.OPENCODE_SERVER_PASSWORD;
    this.timeout = config.timeout ?? 5000;
  }

  /**
   * Build authorization headers if password is set
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.password) {
      // Basic auth with 'opencode' as username
      const auth = Buffer.from(`opencode:${this.password}`).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }
    return headers;
  }

  /**
   * Make a request to the opencode API
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<OpenCodeApiResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.getHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const data = await response.json() as T;
      return { success: true, data };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return { success: false, error: 'Request timeout' };
        }
        return { success: false, error: error.message };
      }
      return { success: false, error: 'Unknown error' };
    }
  }

  // =========================================================================
  // Health Check
  // =========================================================================

  /**
   * Check if opencode serve is running and accessible
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.request<{ version: string }>('GET', '/config');
      return response.success;
    } catch {
      return false;
    }
  }

  /**
   * Wait for opencode serve to become available
   * @param maxWaitMs Maximum time to wait in milliseconds (default: 10000)
   * @param intervalMs Check interval in milliseconds (default: 500)
   */
  async waitForAvailable(maxWaitMs = 10000, intervalMs = 500): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      if (await this.isAvailable()) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  // =========================================================================
  // TUI Control
  // =========================================================================

  /**
   * Append text to the TUI input field
   * This is the primary method for injecting relay messages into opencode
   */
  async appendPrompt(text: string): Promise<OpenCodeApiResponse<boolean>> {
    return this.request<boolean>('POST', '/tui/append-prompt', { text });
  }

  /**
   * Submit the current prompt
   */
  async submitPrompt(): Promise<OpenCodeApiResponse<boolean>> {
    return this.request<boolean>('POST', '/tui/submit-prompt');
  }

  /**
   * Clear the current prompt
   */
  async clearPrompt(): Promise<OpenCodeApiResponse<boolean>> {
    return this.request<boolean>('POST', '/tui/clear-prompt');
  }

  /**
   * Show a toast notification in the TUI
   */
  async showToast(
    message: string,
    options?: { variant?: 'info' | 'success' | 'warning' | 'error'; duration?: number }
  ): Promise<OpenCodeApiResponse<boolean>> {
    return this.request<boolean>('POST', '/tui/show-toast', {
      message,
      variant: options?.variant ?? 'info',
      duration: options?.duration ?? 3000,
    });
  }

  /**
   * Execute a TUI command
   */
  async executeCommand(
    command:
      | 'session_new'
      | 'session_share'
      | 'session_interrupt'
      | 'session_compact'
      | 'agent_cycle'
      | 'messages_page_up'
      | 'messages_page_down'
  ): Promise<OpenCodeApiResponse<boolean>> {
    return this.request<boolean>('POST', '/tui/execute-command', { command });
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  /**
   * List all sessions
   */
  async listSessions(): Promise<OpenCodeApiResponse<OpenCodeSession[]>> {
    return this.request<OpenCodeSession[]>('GET', '/session');
  }

  /**
   * Get the current session
   */
  async getCurrentSession(): Promise<OpenCodeApiResponse<OpenCodeSession>> {
    return this.request<OpenCodeSession>('GET', '/session/current');
  }

  /**
   * Select a session in the TUI
   */
  async selectSession(sessionId: string): Promise<OpenCodeApiResponse<boolean>> {
    return this.request<boolean>('POST', '/tui/select-session', { sessionID: sessionId });
  }

  // =========================================================================
  // Events (SSE)
  // =========================================================================

  /**
   * Subscribe to opencode events via Server-Sent Events
   * Returns an abort function to stop the subscription
   */
  subscribeToEvents(
    onEvent: (event: { type: string; data: unknown }) => void,
    onError?: (error: Error) => void
  ): () => void {
    const controller = new AbortController();

    const connect = async () => {
      try {
        const response = await fetch(`${this.baseUrl}/event`, {
          headers: this.getHeaders(),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                onEvent(data);
              } catch {
                // Ignore parse errors
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name !== 'AbortError') {
          onError?.(error);
        }
      }
    };

    connect();
    return () => controller.abort();
  }
}

/**
 * Default OpenCode API instance
 */
export const openCodeApi = new OpenCodeApi();
