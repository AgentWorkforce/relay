/**
 * Socket Discovery & Cloud Workspace Detection
 *
 * Single source of truth for discovering relay daemon sockets,
 * cloud workspace environments, and agent identity.
 *
 * Previously duplicated in @agent-relay/mcp (cloud.ts). Now consolidated
 * here in the SDK so both SDK and MCP use the same discovery logic.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findProjectRoot } from '@agent-relay/config';

// ============================================================================
// Types
// ============================================================================

export interface CloudWorkspace {
  workspaceId: string;
  cloudApiUrl: string;
  workspaceToken?: string;
  ownerUserId?: string;
}

export interface DiscoveryResult {
  socketPath: string;
  project: string;
  source: 'env' | 'cloud' | 'cwd' | 'scan';
  isCloud: boolean;
  workspace?: CloudWorkspace;
}

export interface CloudConnectionOptions {
  /** Override socket path (for testing) */
  socketPath?: string;
  /** Override workspace detection */
  workspace?: Partial<CloudWorkspace>;
}

export interface CloudConnectionInfo {
  socketPath: string;
  project: string;
  isCloud: boolean;
  workspace?: CloudWorkspace;
  daemonUrl?: string;
}

// ============================================================================
// Cloud Workspace Detection
// ============================================================================

/**
 * Detect if running in a cloud workspace environment.
 *
 * Cloud workspaces set these environment variables:
 * - WORKSPACE_ID: The unique workspace identifier
 * - CLOUD_API_URL: The cloud API endpoint
 * - WORKSPACE_TOKEN: Bearer token for API auth (optional)
 * - WORKSPACE_OWNER_USER_ID: The workspace owner's user ID (optional)
 */
export function detectCloudWorkspace(): CloudWorkspace | null {
  const workspaceId = process.env.WORKSPACE_ID;
  const cloudApiUrl = process.env.CLOUD_API_URL;

  if (!workspaceId || !cloudApiUrl) {
    return null;
  }

  return {
    workspaceId,
    cloudApiUrl,
    workspaceToken: process.env.WORKSPACE_TOKEN,
    ownerUserId: process.env.WORKSPACE_OWNER_USER_ID,
  };
}

/**
 * Check if we're running in a cloud workspace.
 */
export function isCloudWorkspace(): boolean {
  return detectCloudWorkspace() !== null;
}

// ============================================================================
// Workspace-Aware Socket Discovery
// ============================================================================

/**
 * Get the workspace-namespaced socket path.
 *
 * In cloud workspaces, sockets are stored at:
 * /tmp/relay/{WORKSPACE_ID}/sockets/daemon.sock
 *
 * This provides multi-tenant isolation on shared infrastructure.
 */
export function getCloudSocketPath(workspaceId: string): string {
  return `/tmp/relay/${workspaceId}/sockets/daemon.sock`;
}

/**
 * Get the workspace-namespaced outbox path.
 *
 * In cloud workspaces, outbox directories are at:
 * /tmp/relay/{WORKSPACE_ID}/outbox/{agentName}/
 */
export function getCloudOutboxPath(workspaceId: string, agentName: string): string {
  return `/tmp/relay/${workspaceId}/outbox/${agentName}`;
}

/**
 * Get platform-specific data directory.
 */
function getDataDir(): string {
  const platform = process.platform;

  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'agent-relay');
  } else if (platform === 'win32') {
    return join(process.env.APPDATA || homedir(), 'agent-relay');
  } else {
    return join(
      process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
      'agent-relay'
    );
  }
}

/**
 * Discover relay daemon socket with cloud-awareness.
 *
 * Priority order:
 * 1. RELAY_SOCKET environment variable (explicit path)
 * 2. Cloud workspace socket (if WORKSPACE_ID is set)
 * 3. RELAY_PROJECT environment variable (project name -> data dir)
 * 4. Current working directory .relay/config.json
 * 5. Scan data directory for active sockets
 *
 * @param options - Optional configuration overrides
 * @returns Discovery result with socket path, project info, and cloud status
 */
export function discoverSocket(options: CloudConnectionOptions = {}): DiscoveryResult | null {
  // 0. Use override if provided
  if (options.socketPath) {
    const workspace = options.workspace
      ? ({
          workspaceId: options.workspace.workspaceId || 'override',
          cloudApiUrl: options.workspace.cloudApiUrl || '',
        } as CloudWorkspace)
      : undefined;

    return {
      socketPath: options.socketPath,
      project: workspace?.workspaceId || 'override',
      source: 'env',
      isCloud: !!workspace,
      workspace,
    };
  }

  // 1. Explicit socket path from environment
  const socketEnv = process.env.RELAY_SOCKET;
  if (socketEnv) {
    const workspace = detectCloudWorkspace();
    return {
      socketPath: socketEnv,
      project: process.env.RELAY_PROJECT || workspace?.workspaceId || 'unknown',
      source: 'env',
      isCloud: !!workspace,
      workspace: workspace || undefined,
    };
  }

  // 2. Cloud workspace socket (highest priority for cloud environments)
  // Return the determined path even if the socket file doesn't exist yet
  // (daemon may not have started)
  const workspace = detectCloudWorkspace();
  if (workspace) {
    const cloudSocket = getCloudSocketPath(workspace.workspaceId);
    return {
      socketPath: cloudSocket,
      project: workspace.workspaceId,
      source: 'cloud',
      isCloud: true,
      workspace,
    };
  }

  // 3. Project name -> data dir lookup
  const projectEnv = process.env.RELAY_PROJECT;
  if (projectEnv) {
    const dataDir = getDataDir();
    const projectSocket = join(dataDir, 'projects', projectEnv, 'daemon.sock');
    return {
      socketPath: projectSocket,
      project: projectEnv,
      source: 'env',
      isCloud: false,
    };
  }

  // 4. Project-local socket (created by daemon in project's .agent-relay directory)
  // This is the primary path for local development
  // First try cwd, then scan up to find project root
  const projectRoot = findProjectRoot(process.cwd());
  const searchDirs = [process.cwd()];
  if (projectRoot && projectRoot !== process.cwd()) {
    searchDirs.push(projectRoot);
  }

  for (const dir of searchDirs) {
    const projectLocalSocket = join(dir, '.agent-relay', 'relay.sock');
    if (existsSync(projectLocalSocket)) {
      // Read project ID from marker file if available
      let projectId = 'local';
      const markerPath = join(dir, '.agent-relay', '.project');
      if (existsSync(markerPath)) {
        try {
          const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
          projectId = marker.projectId || 'local';
        } catch {
          // Ignore marker read errors
        }
      }
      return {
        socketPath: projectLocalSocket,
        project: projectId,
        source: 'cwd',
        isCloud: false,
      };
    }
  }

  // 4b. Legacy .relay/config.json support
  const cwdConfig = join(process.cwd(), '.relay', 'config.json');
  if (existsSync(cwdConfig)) {
    try {
      const config = JSON.parse(readFileSync(cwdConfig, 'utf-8'));
      if (config.socketPath) {
        return {
          socketPath: config.socketPath,
          project: config.project || 'local',
          source: 'cwd',
          isCloud: false,
        };
      }
    } catch (err) {
      // Invalid config (malformed JSON, permission error, etc.), continue to next method
      if (process.env.DEBUG || process.env.RELAY_DEBUG) {
        console.debug('[discovery] Failed to read cwd config:', cwdConfig, err);
      }
    }
  }

  // 5. Scan data directory for active sockets
  const dataDir = getDataDir();
  const projectsDir = join(dataDir, 'projects');

  if (existsSync(projectsDir)) {
    try {
      const projects = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const project of projects) {
        const socketPath = join(projectsDir, project, 'daemon.sock');
        if (existsSync(socketPath)) {
          return {
            socketPath,
            project,
            source: 'scan',
            isCloud: false,
          };
        }
      }
    } catch (err) {
      // Directory read failed (permission error, etc.), return null
      if (process.env.DEBUG || process.env.RELAY_DEBUG) {
        console.debug('[discovery] Failed to scan projects directory:', projectsDir, err);
      }
    }
  }

  return null;
}

// ============================================================================
// Cloud API Helpers
// ============================================================================

/**
 * Make an authenticated request to the cloud API.
 *
 * @param workspace - Cloud workspace configuration
 * @param path - API path (e.g., '/api/status')
 * @param options - Fetch options
 * @returns Response from the API
 */
export async function cloudApiRequest(
  workspace: CloudWorkspace,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${workspace.cloudApiUrl}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (workspace.workspaceToken) {
    headers['Authorization'] = `Bearer ${workspace.workspaceToken}`;
  }

  return fetch(url, {
    ...options,
    headers,
  });
}

/**
 * Get the workspace status from the cloud API.
 */
export async function getWorkspaceStatus(
  workspace: CloudWorkspace
): Promise<{ status: string; agents?: string[] } | null> {
  try {
    const response = await cloudApiRequest(
      workspace,
      `/api/workspaces/${workspace.workspaceId}/status`
    );

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as { status: string; agents?: string[] };
  } catch {
    return null;
  }
}

// ============================================================================
// Cloud Connection Factory
// ============================================================================

/**
 * Get connection info for the relay daemon.
 *
 * This function determines the best way to connect to the daemon:
 * - In cloud environments: Uses workspace-namespaced socket
 * - In local environments: Uses standard socket discovery
 *
 * @param options - Optional configuration overrides
 * @returns Connection info or null if daemon not found
 */
export function getConnectionInfo(
  options: CloudConnectionOptions = {}
): CloudConnectionInfo | null {
  const discovery = discoverSocket(options);

  if (!discovery) {
    return null;
  }

  const info: CloudConnectionInfo = {
    socketPath: discovery.socketPath,
    project: discovery.project,
    isCloud: discovery.isCloud,
    workspace: discovery.workspace,
  };

  // In cloud environments, we may also have a daemon URL for HTTP API access
  if (discovery.workspace?.cloudApiUrl) {
    info.daemonUrl = discovery.workspace.cloudApiUrl;
  }

  return info;
}

/**
 * Environment variable summary for debugging.
 */
export function getCloudEnvironmentSummary(): Record<string, string | undefined> {
  return {
    WORKSPACE_ID: process.env.WORKSPACE_ID,
    CLOUD_API_URL: process.env.CLOUD_API_URL,
    WORKSPACE_TOKEN: process.env.WORKSPACE_TOKEN ? '[set]' : undefined,
    WORKSPACE_OWNER_USER_ID: process.env.WORKSPACE_OWNER_USER_ID,
    RELAY_SOCKET: process.env.RELAY_SOCKET,
    RELAY_PROJECT: process.env.RELAY_PROJECT,
    RELAY_AGENT_NAME: process.env.RELAY_AGENT_NAME,
  };
}

// ============================================================================
// Agent Identity Discovery
// ============================================================================

/**
 * Discover the agent name for the MCP server.
 *
 * Priority order:
 * 1. RELAY_AGENT_NAME environment variable (explicit)
 * 2. Identity file in .agent-relay directory (written by wrapper)
 * 3. Scan outbox directories to find agent's outbox
 *
 * @param _discovery - Optional discovery result (reserved for future use)
 * @returns Agent name or null if not found
 */
export function discoverAgentName(_discovery?: DiscoveryResult | null): string | null {
  // 1. Explicit environment variable
  const envName = process.env.RELAY_AGENT_NAME;
  if (envName) {
    return envName;
  }

  // 2. Identity file in .agent-relay directory
  // The wrapper creates this file with the agent name
  const projectRoot = findProjectRoot(process.cwd());
  const searchDirs = [process.cwd()];
  if (projectRoot && projectRoot !== process.cwd()) {
    searchDirs.push(projectRoot);
  }

  for (const dir of searchDirs) {
    const relayDir = join(dir, '.agent-relay');
    if (!existsSync(relayDir)) continue;

    // First check for per-process identity files
    // The orchestrator writes mcp-identity-{orchestrator.pid}
    // Try to find one by checking process.ppid and its ancestors
    const pidIdentityPath = join(relayDir, `mcp-identity-${process.ppid}`);
    if (existsSync(pidIdentityPath)) {
      try {
        const content = readFileSync(pidIdentityPath, 'utf-8').trim();
        if (content) {
          return content;
        }
      } catch {
        // Ignore read errors
      }
    }

    // Scan all mcp-identity-* files and return the most recently modified one
    // This handles the case where MCP server's ppid doesn't match the orchestrator
    try {
      const files = readdirSync(relayDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.startsWith('mcp-identity-'))
        .map((d) => ({
          path: join(relayDir, d.name),
          name: d.name,
        }));

      if (files.length > 0) {
        // Sort by mtime (most recent first) to get the latest identity
        const sorted = files
          .map((f) => {
            try {
              const stat = statSync(f.path);
              return { ...f, mtime: stat.mtimeMs };
            } catch {
              return { ...f, mtime: 0 };
            }
          })
          .sort((a, b) => b.mtime - a.mtime);

        // Return the most recently modified identity file
        const latest = sorted[0];
        if (latest) {
          try {
            const content = readFileSync(latest.path, 'utf-8').trim();
            if (content) {
              return content;
            }
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Ignore scan errors
    }

    // Fallback to simple identity file (for single-agent scenarios)
    const identityPath = join(relayDir, 'mcp-identity');
    if (existsSync(identityPath)) {
      try {
        const content = readFileSync(identityPath, 'utf-8').trim();
        if (content) {
          return content;
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // 3. Check outbox directories for a match
  // If only one agent's outbox exists, assume we're that agent
  for (const dir of searchDirs) {
    const outboxDir = join(dir, '.agent-relay', 'outbox');
    if (existsSync(outboxDir)) {
      try {
        const agents = readdirSync(outboxDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        // If there's exactly one outbox, use that agent name
        if (agents.length === 1) {
          return agents[0];
        }

        // If there are multiple, we can't determine which one we are
        // The wrapper should have created an identity file
      } catch {
        // Ignore read errors
      }
    }
  }

  return null;
}
