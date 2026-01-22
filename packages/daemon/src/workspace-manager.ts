/**
 * Workspace Manager
 * Manages multiple workspaces (repositories) and handles switching between them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { createLogger } from '@agent-relay/resiliency';
import type {
  Workspace,
  WorkspaceStatus,
  ProviderType,
  DaemonEvent,
  AddWorkspaceRequest,
} from './types.js';

const logger = createLogger('workspace-manager');

function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export class WorkspaceManager extends EventEmitter {
  private workspaces = new Map<string, Workspace>();
  private activeWorkspaceId?: string;
  private dataDir: string;
  private workspacesFile: string;

  constructor(dataDir: string) {
    super();
    this.dataDir = dataDir;
    this.workspacesFile = path.join(dataDir, 'workspaces.json');

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Load existing workspaces
    this.loadWorkspaces();
  }

  /**
   * Add a new workspace
   */
  add(request: AddWorkspaceRequest): Workspace {
    const resolvedPath = this.resolvePath(request.path);

    // Check if already exists
    const existing = this.findByPath(resolvedPath);
    if (existing) {
      logger.info('Workspace already exists', { id: existing.id, path: resolvedPath });
      return existing;
    }

    // Validate path exists
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }

    // Get git info
    const gitInfo = this.getGitInfo(resolvedPath);

    const workspace: Workspace = {
      id: generateId(),
      name: request.name || path.basename(resolvedPath),
      path: resolvedPath,
      status: 'inactive',
      provider: request.provider || this.detectProvider(resolvedPath),
      createdAt: new Date(),
      lastActiveAt: new Date(),
      gitRemote: gitInfo.remote,
      gitBranch: gitInfo.branch,
    };

    this.workspaces.set(workspace.id, workspace);
    this.saveWorkspaces();

    logger.info('Workspace added', { id: workspace.id, name: workspace.name, path: resolvedPath });

    this.emitEvent({
      type: 'workspace:added',
      workspaceId: workspace.id,
      data: workspace,
      timestamp: new Date(),
    });

    return workspace;
  }

  /**
   * Remove a workspace
   */
  remove(workspaceId: string): boolean {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      return false;
    }

    // If this is the active workspace, deactivate first
    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = undefined;
    }

    // Clean up workspace temp directory if it exists
    // (for workspace-namespaced paths: /tmp/relay/{workspaceId}/)
    this.cleanupWorkspaceTempDir(workspaceId);

    this.workspaces.delete(workspaceId);
    this.saveWorkspaces();

    logger.info('Workspace removed', { id: workspaceId, name: workspace.name });

    this.emitEvent({
      type: 'workspace:removed',
      workspaceId,
      data: { id: workspaceId, name: workspace.name },
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Switch to a workspace (set as active)
   */
  switchTo(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const previousId = this.activeWorkspaceId;

    // Deactivate previous workspace
    if (previousId && previousId !== workspaceId) {
      const prev = this.workspaces.get(previousId);
      if (prev) {
        prev.status = 'inactive';
      }
    }

    // Activate new workspace
    workspace.status = 'active';
    workspace.lastActiveAt = new Date();
    this.activeWorkspaceId = workspaceId;

    this.saveWorkspaces();

    logger.info('Switched to workspace', { id: workspaceId, name: workspace.name });

    this.emitEvent({
      type: 'workspace:switched',
      workspaceId,
      data: { previousId, currentId: workspaceId, workspace },
      timestamp: new Date(),
    });

    return workspace;
  }

  /**
   * Get a workspace by ID
   */
  get(workspaceId: string): Workspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  /**
   * Get the active workspace
   */
  getActive(): Workspace | undefined {
    if (!this.activeWorkspaceId) return undefined;
    return this.workspaces.get(this.activeWorkspaceId);
  }

  /**
   * Get all workspaces
   */
  getAll(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  /**
   * Find workspace by path
   */
  findByPath(workspacePath: string): Workspace | undefined {
    const resolved = this.resolvePath(workspacePath);
    return Array.from(this.workspaces.values()).find((w) => w.path === resolved);
  }

  /**
   * Update workspace status
   */
  updateStatus(workspaceId: string, status: WorkspaceStatus): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    workspace.status = status;
    this.saveWorkspaces();

    this.emitEvent({
      type: 'workspace:updated',
      workspaceId,
      data: { status },
      timestamp: new Date(),
    });
  }

  /**
   * Update workspace git info
   */
  refreshGitInfo(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;

    const gitInfo = this.getGitInfo(workspace.path);
    workspace.gitRemote = gitInfo.remote;
    workspace.gitBranch = gitInfo.branch;
    this.saveWorkspaces();
  }

  /**
   * Resolve path (expand ~ and make absolute)
   */
  private resolvePath(p: string): string {
    if (p.startsWith('~')) {
      p = path.join(process.env.HOME || '', p.slice(1));
    }
    return path.resolve(p);
  }

  /**
   * Detect provider from workspace files
   */
  private detectProvider(workspacePath: string): ProviderType {
    // Check for CLAUDE.md or .claude directory
    if (
      fs.existsSync(path.join(workspacePath, 'CLAUDE.md')) ||
      fs.existsSync(path.join(workspacePath, '.claude'))
    ) {
      return 'claude';
    }

    // Check for .codex directory
    if (fs.existsSync(path.join(workspacePath, '.codex'))) {
      return 'codex';
    }

    // Check for .gemini directory
    if (fs.existsSync(path.join(workspacePath, '.gemini'))) {
      return 'gemini';
    }

    return 'generic';
  }

  /**
   * Get git info for a workspace
   */
  private getGitInfo(workspacePath: string): { remote?: string; branch?: string } {
    try {
      const branch = execSync('git branch --show-current', {
        cwd: workspacePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      let remote: string | undefined;
      try {
        remote = execSync('git remote get-url origin', {
          cwd: workspacePath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        // No remote configured
      }

      return { remote, branch };
    } catch {
      // Not a git repo
      return {};
    }
  }

  /**
   * Load workspaces from disk
   */
  private loadWorkspaces(): void {
    if (!fs.existsSync(this.workspacesFile)) {
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.workspacesFile, 'utf8'));
      if (Array.isArray(data.workspaces)) {
        for (const w of data.workspaces) {
          this.workspaces.set(w.id, {
            ...w,
            createdAt: new Date(w.createdAt),
            lastActiveAt: new Date(w.lastActiveAt),
            status: 'inactive', // Reset status on load
          });
        }
      }
      this.activeWorkspaceId = data.activeWorkspaceId;

      logger.info('Loaded workspaces', { count: this.workspaces.size });
    } catch (err) {
      logger.error('Failed to load workspaces', { error: String(err) });
    }
  }

  /**
   * Save workspaces to disk
   */
  private saveWorkspaces(): void {
    try {
      const data = {
        workspaces: Array.from(this.workspaces.values()),
        activeWorkspaceId: this.activeWorkspaceId,
      };
      fs.writeFileSync(this.workspacesFile, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error('Failed to save workspaces', { error: String(err) });
    }
  }

  /**
   * Emit a daemon event
   */
  private emitEvent(event: DaemonEvent): void {
    this.emit('event', event);
  }

  /**
   * Clean up workspace temp directory
   * Removes /tmp/relay/{workspaceId}/ which contains sockets and outbox
   */
  private cleanupWorkspaceTempDir(workspaceId: string): void {
    const workspaceTempDir = path.join('/tmp', 'relay', workspaceId);

    try {
      if (fs.existsSync(workspaceTempDir)) {
        // Recursively remove the directory
        fs.rmSync(workspaceTempDir, { recursive: true, force: true });
        logger.info('Cleaned up workspace temp directory', { workspaceId, path: workspaceTempDir });
      }
    } catch (err) {
      // Log but don't fail - cleanup is best-effort
      logger.warn('Failed to clean up workspace temp directory', {
        workspaceId,
        path: workspaceTempDir,
        error: String(err),
      });
    }
  }
}

let workspaceManagerInstance: WorkspaceManager | undefined;

export function getWorkspaceManager(dataDir?: string): WorkspaceManager {
  if (!workspaceManagerInstance) {
    const dir = dataDir || path.join(process.env.HOME || '', '.agent-relay', 'daemon');
    workspaceManagerInstance = new WorkspaceManager(dir);
  }
  return workspaceManagerInstance;
}
