/**
 * Public API for @agent-relay/slack-mcp-server
 *
 * The package can be used three ways:
 *   1. As an MCP server (run `slack-mcp` binary)
 *   2. As a CLI tool (run `slack-mcp-cli` binary)
 *   3. As a library (import Engine, Storage, etc.)
 */

export { Storage } from './storage.js';
export { Engine, type MessageEvent, type MessageListener } from './engine.js';
export { createMCPSession } from './server.js';
export { ALL_TOOLS, handleToolCall, handleToolCallWithNotification } from './tools.js';
export { snowflake, snowflakeToTimestamp, timestampToSnowflake } from './snowflake.js';

export type {
  Workspace,
  Agent,
  Channel,
  ChannelMember,
  Message,
  Reaction,
  ReactionSummary,
  UnreadInfo,
  InboxResult,
  GetMessagesOptions,
  SearchOptions,
  SessionState,
} from './types.js';

export { ChannelType } from './types.js';
