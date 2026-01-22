export interface RelayClient {
  send(to: string, message: string, options?: { thread?: string }): Promise<void>;
  sendAndWait(
    to: string,
    message: string,
    options?: { thread?: string; timeoutMs?: number }
  ): Promise<{ from: string; content: string; thread?: string }>;
  getInbox(options?: {
    limit?: number;
    unread_only?: boolean;
    from?: string;
    channel?: string;
  }): Promise<
    Array<{
      id: string;
      from: string;
      content: string;
      channel?: string;
      thread?: string;
    }>
  >;
  listAgents(options?: { include_idle?: boolean; project?: string }): Promise<
    Array<{
      name: string;
      cli: string;
      idle?: boolean;
      parent?: string;
    }>
  >;
}
