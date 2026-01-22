/**
 * Relay File Writer
 *
 * Provides a clean abstraction for writing relay messages and attachments
 * to the file system with a structured directory layout.
 *
 * Directory structure:
 * ~/.agent-relay/
 *   outbox/{agent-name}/              # Agent outbox messages
 *   attachments/{agent-name}/{ts}/    # Attachments organized by timestamp
 *   meta/                             # Configuration and state files
 *
 * For cloud workspaces with WORKSPACE_ID:
 * /tmp/relay/{workspaceId}/
 *   outbox/{agent-name}/
 *   attachments/{agent-name}/{ts}/
 *
 * Legacy path (for backward compatibility):
 * /tmp/relay-outbox/{agent-name}/     # Symlinked to actual outbox
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export interface RelayPaths {
  /** Root directory for relay data */
  rootDir: string;
  /** Outbox directory for all agents */
  outboxDir: string;
  /** Attachments directory for all agents */
  attachmentsDir: string;
  /** Meta directory for configuration/state */
  metaDir: string;
  /** Legacy outbox path (for backward compatibility) */
  legacyOutboxDir: string;
}

export interface AgentPaths extends RelayPaths {
  /** Agent-specific outbox directory */
  agentOutbox: string;
  /** Agent-specific attachments directory */
  agentAttachments: string;
  /** Whether this is a workspace (cloud) deployment */
  isWorkspace: boolean;
  /** The agent name */
  agentName: string;
}

export interface WriteOptions {
  /** Create directories if they don't exist (default: true) */
  mkdir?: boolean;
  /** File mode (default: 0o644) */
  mode?: number;
}

export interface AttachmentResult {
  /** Full path to the attachment */
  path: string;
  /** Relative path from attachments root */
  relativePath: string;
  /** Timestamp directory */
  timestamp: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_SOCKET_PATH_LENGTH = 107;
const DEFAULT_OUTBOX_DIR = 'outbox';
const DEFAULT_ATTACHMENTS_DIR = 'attachments';
const DEFAULT_META_DIR = 'meta';
const LEGACY_OUTBOX_BASE = '/tmp/relay-outbox';

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Hash a workspace ID to keep paths short (for Unix socket length limits)
 */
function hashWorkspaceId(workspaceId: string): string {
  return crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 12);
}

/**
 * Get the base directory for relay data.
 * Priority:
 * 1. AGENT_RELAY_DATA_DIR environment variable
 * 2. XDG_DATA_HOME/agent-relay (Linux/macOS standard)
 * 3. ~/.agent-relay (fallback)
 */
function getBaseDir(): string {
  // Explicit override
  if (process.env.AGENT_RELAY_DATA_DIR) {
    return process.env.AGENT_RELAY_DATA_DIR;
  }

  // XDG Base Directory Specification
  const xdgDataHome = process.env.XDG_DATA_HOME;
  if (xdgDataHome) {
    return path.join(xdgDataHome, 'agent-relay');
  }

  // Default: ~/.agent-relay
  return path.join(os.homedir(), '.agent-relay');
}

/**
 * Get workspace-specific paths for cloud deployments.
 * Uses /tmp/relay/{workspaceId} to ensure workspace isolation.
 */
function getWorkspacePaths(workspaceId: string): RelayPaths {
  let effectiveId = workspaceId;
  let workspaceDir = `/tmp/relay/${workspaceId}`;

  // Check if path would be too long for sockets
  const testSocketPath = `${workspaceDir}/sockets/test.sock`;
  if (testSocketPath.length > MAX_SOCKET_PATH_LENGTH) {
    effectiveId = hashWorkspaceId(workspaceId);
    workspaceDir = `/tmp/relay/${effectiveId}`;
  }

  return {
    rootDir: workspaceDir,
    outboxDir: path.join(workspaceDir, DEFAULT_OUTBOX_DIR),
    attachmentsDir: path.join(workspaceDir, DEFAULT_ATTACHMENTS_DIR),
    metaDir: path.join(workspaceDir, DEFAULT_META_DIR),
    legacyOutboxDir: LEGACY_OUTBOX_BASE,
  };
}

/**
 * Get local (non-workspace) relay paths.
 * Uses ~/.agent-relay for persistent storage.
 */
function getLocalPaths(): RelayPaths {
  const baseDir = getBaseDir();

  return {
    rootDir: baseDir,
    outboxDir: path.join(baseDir, DEFAULT_OUTBOX_DIR),
    attachmentsDir: path.join(baseDir, DEFAULT_ATTACHMENTS_DIR),
    metaDir: path.join(baseDir, DEFAULT_META_DIR),
    legacyOutboxDir: LEGACY_OUTBOX_BASE,
  };
}

// ============================================================================
// RelayFileWriter Class
// ============================================================================

/**
 * Utility class for writing relay messages and attachments.
 *
 * @example
 * ```typescript
 * const writer = new RelayFileWriter('MyAgent');
 *
 * // Write a message
 * await writer.writeMessage('msg', `TO: Lead\n\nACK: Task received`);
 *
 * // Write an attachment
 * const result = await writer.writeAttachment('screenshot.png', imageBuffer);
 * console.log(`Attachment saved to: ${result.path}`);
 * ```
 */
export class RelayFileWriter {
  private readonly agentName: string;
  private readonly paths: AgentPaths;
  private readonly workspaceId?: string;

  constructor(agentName: string, workspaceId?: string) {
    this.agentName = agentName;
    this.workspaceId = workspaceId ?? process.env.WORKSPACE_ID;

    // Resolve paths based on environment
    const basePaths = this.workspaceId
      ? getWorkspacePaths(this.workspaceId)
      : getLocalPaths();

    this.paths = {
      ...basePaths,
      agentOutbox: path.join(basePaths.outboxDir, agentName),
      agentAttachments: path.join(basePaths.attachmentsDir, agentName),
      isWorkspace: !!this.workspaceId,
      agentName,
    };
  }

  /**
   * Get the resolved paths for this agent.
   */
  getPaths(): AgentPaths {
    return { ...this.paths };
  }

  /**
   * Get the outbox path that agents should write to.
   * For cloud: uses workspace path directly
   * For local: uses legacy path (which may be symlinked)
   */
  getOutboxPath(): string {
    // In workspace mode, agents use the workspace path directly
    if (this.paths.isWorkspace) {
      return this.paths.agentOutbox;
    }
    // For local mode, use legacy path for backward compatibility
    return path.join(this.paths.legacyOutboxDir, this.agentName);
  }

  /**
   * Get the legacy outbox path (for symlink creation).
   */
  getLegacyOutboxPath(): string {
    return path.join(this.paths.legacyOutboxDir, this.agentName);
  }

  /**
   * Ensure all necessary directories exist for this agent.
   * Also sets up symlinks for backward compatibility in workspace mode.
   */
  async ensureDirectories(): Promise<void> {
    // Create agent-specific directories
    await fs.promises.mkdir(this.paths.agentOutbox, { recursive: true });
    await fs.promises.mkdir(this.paths.agentAttachments, { recursive: true });
    await fs.promises.mkdir(this.paths.metaDir, { recursive: true });

    // In workspace mode, create symlink from legacy path to workspace path
    if (this.paths.isWorkspace) {
      await this.setupLegacySymlink();
    } else {
      // For local mode, ensure legacy outbox exists
      const legacyPath = path.join(this.paths.legacyOutboxDir, this.agentName);
      await fs.promises.mkdir(legacyPath, { recursive: true });
    }
  }

  /**
   * Set up symlink from legacy outbox path to workspace outbox path.
   * This allows agents to use simple instructions while maintaining workspace isolation.
   */
  private async setupLegacySymlink(): Promise<void> {
    const legacyPath = path.join(this.paths.legacyOutboxDir, this.agentName);
    const legacyParent = path.dirname(legacyPath);

    try {
      // Ensure legacy parent directory exists
      await fs.promises.mkdir(legacyParent, { recursive: true });

      // Check if legacy path exists
      try {
        const stats = await fs.promises.lstat(legacyPath);

        if (stats.isSymbolicLink()) {
          // Already a symlink - verify it points to correct location
          const target = await fs.promises.readlink(legacyPath);
          if (target === this.paths.agentOutbox) {
            return; // Already correctly configured
          }
          // Wrong target - remove and recreate
          await fs.promises.unlink(legacyPath);
        } else if (stats.isDirectory()) {
          // Regular directory - remove it (may have stale files)
          await fs.promises.rm(legacyPath, { recursive: true, force: true });
        }
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
        // Path doesn't exist - good, we'll create the symlink
      }

      // Create symlink: legacy path -> workspace path
      await fs.promises.symlink(this.paths.agentOutbox, legacyPath);
    } catch (err: any) {
      console.error(`[relay-file-writer] Failed to setup legacy symlink: ${err.message}`);
      // Fall back to creating the directory directly
      try {
        await fs.promises.mkdir(legacyPath, { recursive: true });
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Write a message to the agent's outbox.
   *
   * @param messageType - Type/name of the message (e.g., 'msg', 'ack', 'done')
   * @param content - Message content (headers + body)
   * @param options - Write options
   * @returns Full path to the written file
   *
   * @example
   * ```typescript
   * await writer.writeMessage('ack', `TO: Lead\n\nACK: Task received`);
   * ```
   */
  async writeMessage(
    messageType: string,
    content: string,
    options: WriteOptions = {}
  ): Promise<string> {
    const { mkdir = true, mode = 0o644 } = options;

    if (mkdir) {
      await this.ensureDirectories();
    }

    const filePath = path.join(this.paths.agentOutbox, messageType);
    await fs.promises.writeFile(filePath, content, { mode });
    return filePath;
  }

  /**
   * Write an attachment to the agent's attachments directory.
   * Attachments are organized by timestamp to prevent collisions.
   *
   * @param fileName - Name of the attachment file
   * @param data - File content (string or Buffer)
   * @param options - Write options
   * @returns Attachment result with paths
   *
   * @example
   * ```typescript
   * const result = await writer.writeAttachment('screenshot.png', imageBuffer);
   * console.log(`Saved to: ${result.path}`);
   * ```
   */
  async writeAttachment(
    fileName: string,
    data: string | Buffer,
    options: WriteOptions = {}
  ): Promise<AttachmentResult> {
    const { mkdir = true, mode = 0o644 } = options;

    // Create timestamp-based subdirectory
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const attachmentDir = path.join(this.paths.agentAttachments, timestamp);

    if (mkdir) {
      await fs.promises.mkdir(attachmentDir, { recursive: true });
    }

    const filePath = path.join(attachmentDir, fileName);
    await fs.promises.writeFile(filePath, data, { mode });

    return {
      path: filePath,
      relativePath: path.join(this.agentName, timestamp, fileName),
      timestamp,
    };
  }

  /**
   * Read a message from the agent's outbox.
   *
   * @param messageType - Type/name of the message
   * @returns Message content or null if not found
   */
  async readMessage(messageType: string): Promise<string | null> {
    const filePath = path.join(this.paths.agentOutbox, messageType);
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Delete a message from the agent's outbox.
   *
   * @param messageType - Type/name of the message
   * @returns true if deleted, false if not found
   */
  async deleteMessage(messageType: string): Promise<boolean> {
    const filePath = path.join(this.paths.agentOutbox, messageType);
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  /**
   * List all messages in the agent's outbox.
   *
   * @returns Array of message type names
   */
  async listMessages(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.paths.agentOutbox);
      return entries.filter(e => !e.startsWith('.'));
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Write metadata to the meta directory.
   *
   * @param key - Metadata key (file name)
   * @param data - Metadata content (will be JSON stringified if object)
   */
  async writeMeta(key: string, data: string | Record<string, unknown>): Promise<string> {
    await fs.promises.mkdir(this.paths.metaDir, { recursive: true });

    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const filePath = path.join(this.paths.metaDir, key);
    await fs.promises.writeFile(filePath, content);
    return filePath;
  }

  /**
   * Read metadata from the meta directory.
   *
   * @param key - Metadata key (file name)
   * @param parse - If true, parse as JSON (default: false)
   */
  async readMeta<T = string>(key: string, parse?: false): Promise<T | null>;
  async readMeta<T>(key: string, parse: true): Promise<T | null>;
  async readMeta<T>(key: string, parse = false): Promise<T | null> {
    const filePath = path.join(this.paths.metaDir, key);
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return parse ? JSON.parse(content) as T : content as T;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Clean up the agent's outbox (remove all messages).
   */
  async cleanOutbox(): Promise<void> {
    try {
      const entries = await fs.promises.readdir(this.paths.agentOutbox);
      for (const entry of entries) {
        await fs.promises.unlink(path.join(this.paths.agentOutbox, entry));
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

// ============================================================================
// Static Utility Functions
// ============================================================================

/**
 * Get relay paths for an agent (without creating an instance).
 */
export function getRelayPaths(agentName: string, workspaceId?: string): AgentPaths {
  const writer = new RelayFileWriter(agentName, workspaceId);
  return writer.getPaths();
}

/**
 * Get the base relay paths (not agent-specific).
 */
export function getBaseRelayPaths(workspaceId?: string): RelayPaths {
  const effectiveWorkspaceId = workspaceId ?? process.env.WORKSPACE_ID;
  return effectiveWorkspaceId
    ? getWorkspacePaths(effectiveWorkspaceId)
    : getLocalPaths();
}

/**
 * Get the outbox path that should be used in agent instructions.
 * This is the path agents will write to in their bash commands.
 *
 * @param agentNameVar - Variable name for agent (default: '$AGENT_RELAY_NAME')
 * @returns Path template for agent instructions
 */
export function getAgentOutboxTemplate(agentNameVar = '$AGENT_RELAY_NAME'): string {
  // Always use the legacy path in instructions since:
  // 1. It's simpler for agents to remember
  // 2. Symlinks handle the mapping to workspace paths
  return `${LEGACY_OUTBOX_BASE}/${agentNameVar}`;
}

/**
 * Ensure the base relay directories exist.
 */
export async function ensureBaseDirectories(workspaceId?: string): Promise<RelayPaths> {
  const paths = getBaseRelayPaths(workspaceId);

  await fs.promises.mkdir(paths.outboxDir, { recursive: true });
  await fs.promises.mkdir(paths.attachmentsDir, { recursive: true });
  await fs.promises.mkdir(paths.metaDir, { recursive: true });
  await fs.promises.mkdir(paths.legacyOutboxDir, { recursive: true });

  return paths;
}
