/**
 * CoordinatorPanel Component
 *
 * Manage bridge-level coordinator agents that oversee multiple projects.
 * Available in cloud mode for Pro+ users.
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { Project } from '../types';

export interface ProjectGroup {
  id: string;
  name: string;
  repositoryIds: string[];
  coordinator?: {
    enabled: boolean;
    name?: string;
    model?: string;
    status?: 'stopped' | 'starting' | 'running' | 'error';
  };
  createdAt: string;
}

export interface CoordinatorPanelProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Project[];
  isCloudMode?: boolean;
  /** Whether an Architect agent is already running */
  hasArchitect?: boolean;
  /** Callback when Architect is spawned */
  onArchitectSpawned?: () => void;
}

export function CoordinatorPanel({
  isOpen,
  onClose,
  projects,
  isCloudMode = false,
  hasArchitect = false,
  onArchitectSpawned,
}: CoordinatorPanelProps) {
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [isSpawningArchitect, setIsSpawningArchitect] = useState(false);
  const [selectedCli, setSelectedCli] = useState('claude');

  // Fetch project groups on open
  useEffect(() => {
    if (isOpen && isCloudMode) {
      fetchProjectGroups();
    }
  }, [isOpen, isCloudMode]);

  const fetchProjectGroups = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/project-groups');
      if (response.ok) {
        const data = await response.json();
        setProjectGroups(data.groups || []);
      } else {
        setError('Failed to load project groups');
      }
    } catch (err) {
      setError('Failed to load project groups');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim() || selectedProjects.size === 0) return;

    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/project-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newGroupName,
          repositoryIds: Array.from(selectedProjects),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.group) {
          setProjectGroups((prev) => [...prev, data.group]);
          setShowCreateForm(false);
          setNewGroupName('');
          setSelectedProjects(new Set());
        }
      } else {
        setError('Failed to create project group');
      }
    } catch (err) {
      setError('Failed to create project group');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEnableCoordinator = async (groupId: string, enable: boolean) => {
    setError(null);
    try {
      const endpoint = `/api/project-groups/${groupId}/coordinator/${enable ? 'enable' : 'disable'}`;
      const response = await fetch(endpoint, { method: 'POST' });

      if (response.ok) {
        setProjectGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  coordinator: {
                    ...g.coordinator,
                    enabled: enable,
                    status: enable ? 'starting' : 'stopped',
                  },
                }
              : g
          )
        );
      } else {
        setError(`Failed to ${enable ? 'enable' : 'disable'} coordinator`);
      }
    } catch (err) {
      setError(`Failed to ${enable ? 'enable' : 'disable'} coordinator`);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!window.confirm('Delete this project group? The coordinator will be stopped.')) {
      return;
    }

    try {
      const response = await fetch(`/api/project-groups/${groupId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setProjectGroups((prev) => prev.filter((g) => g.id !== groupId));
      } else {
        setError('Failed to delete project group');
      }
    } catch (err) {
      setError('Failed to delete project group');
    }
  };

  const toggleProject = (projectId: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  if (!isOpen) return null;

  // Spawn architect handler for local mode
  const handleSpawnArchitect = async () => {
    setIsSpawningArchitect(true);
    setError(null);
    try {
      const response = await fetch('/api/spawn/architect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cli: selectedCli }),
      });

      const data = await response.json();
      if (response.ok && data.success) {
        onArchitectSpawned?.();
        onClose();
      } else {
        setError(data.error || 'Failed to spawn Architect');
      }
    } catch (err) {
      setError('Failed to spawn Architect');
    } finally {
      setIsSpawningArchitect(false);
    }
  };

  // Local mode: show spawn architect UI
  if (!isCloudMode) {
    const isInBridgeMode = projects.length > 1;

    return (
      <div
        className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000] animate-fade-in"
        onClick={onClose}
      >
        <div
          className="bg-bg-secondary rounded-xl w-[500px] max-w-[90vw] max-h-[80vh] flex flex-col shadow-modal animate-slide-up"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between py-5 px-6 border-b border-border-subtle">
            <div className="flex items-center gap-3">
              <CoordinatorIcon />
              <h2 className="m-0 text-lg font-semibold text-text-primary">Coordinator Agent</h2>
            </div>
            <button
              className="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-md text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-hover hover:text-text-primary"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {error && (
              <div className="bg-error/10 border border-error/30 rounded-lg p-3 mb-4 text-error text-sm">
                {error}
              </div>
            )}

            {/* Spawn from dashboard - only in bridge mode */}
            {isInBridgeMode && (
              <div className="bg-gradient-to-r from-accent-purple/10 to-accent-cyan/10 border border-accent-purple/30 rounded-lg p-4 mb-4">
                <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
                  <CoordinatorIcon />
                  Spawn Architect
                </h3>

                {hasArchitect ? (
                  <div className="flex items-center gap-2 text-sm text-success">
                    <CheckIcon />
                    Architect is running
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-text-secondary mb-4">
                      Spawn an Architect agent to coordinate across your {projects.length} connected projects.
                    </p>

                    <div className="flex items-center gap-3">
                      <select
                        className="flex-1 py-2 px-3 bg-bg-card border border-border-subtle rounded-md text-sm text-text-primary outline-none focus:border-accent-purple/50"
                        value={selectedCli}
                        onChange={(e) => setSelectedCli(e.target.value)}
                      >
                        <option value="claude">Claude (default)</option>
                        <option value="claude:opus">Claude Opus</option>
                        <option value="claude:sonnet">Claude Sonnet</option>
                        <option value="codex">Codex</option>
                      </select>
                      <button
                        className="py-2 px-4 bg-gradient-to-r from-accent-purple to-accent-cyan text-bg-deep rounded-md text-sm font-semibold hover:shadow-lg transition-all disabled:opacity-50"
                        onClick={handleSpawnArchitect}
                        disabled={isSpawningArchitect}
                      >
                        {isSpawningArchitect ? 'Spawning...' : 'Spawn'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Not in bridge mode message */}
            {!isInBridgeMode && (
              <div className="bg-bg-tertiary rounded-lg p-4 mb-4 border border-border-subtle">
                <h3 className="text-sm font-semibold text-text-primary mb-2">Not in Bridge Mode</h3>
                <p className="text-sm text-text-secondary">
                  The Architect coordinates multiple projects. Start bridge mode to enable:
                </p>
                <div className="bg-bg-card rounded-lg p-3 font-mono text-sm mt-3">
                  <span className="text-text-muted">$</span>{' '}
                  <span className="text-accent-cyan">relay bridge</span>{' '}
                  <span className="text-accent-orange">~/project1 ~/project2</span>
                </div>
              </div>
            )}

            <div className="bg-bg-tertiary rounded-lg p-4 mb-4">
              <h3 className="text-sm font-semibold text-text-primary mb-2">CLI Alternative</h3>
              <p className="text-sm text-text-secondary mb-3">
                You can also spawn the Architect via CLI with the <code className="bg-bg-card px-1.5 py-0.5 rounded text-accent-cyan">--architect</code> flag:
              </p>
              <div className="bg-bg-card rounded-lg p-3 font-mono text-sm">
                <span className="text-text-muted">$</span>{' '}
                <span className="text-accent-cyan">relay bridge</span>{' '}
                <span className="text-accent-orange">~/project1 ~/project2</span>{' '}
                <span className="text-accent-purple">--architect</span>
              </div>
            </div>
          </div>

          <div className="flex justify-end py-4 px-6 border-t border-border-subtle">
            <button
              className="py-2 px-5 bg-bg-tertiary border border-border-subtle rounded-md text-sm text-text-secondary cursor-pointer transition-colors duration-150 hover:bg-bg-hover"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Cloud mode: full coordinator management
  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[1000] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-bg-secondary rounded-xl w-[600px] max-w-[90vw] max-h-[80vh] flex flex-col shadow-modal animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between py-5 px-6 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <CoordinatorIcon />
            <h2 className="m-0 text-lg font-semibold text-text-primary">Coordinator Agents</h2>
          </div>
          <button
            className="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-md text-text-secondary cursor-pointer transition-all duration-150 hover:bg-bg-hover hover:text-text-primary"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="bg-error/10 border border-error/30 rounded-lg p-3 mb-4 text-error text-sm">
              {error}
            </div>
          )}

          {isLoading && projectGroups.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-text-muted">
              <LoadingSpinner />
            </div>
          ) : (
            <>
              {/* Existing project groups */}
              {projectGroups.length > 0 && (
                <div className="space-y-3 mb-6">
                  <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Project Groups
                  </h4>
                  {projectGroups.map((group) => (
                    <div
                      key={group.id}
                      className="bg-bg-tertiary rounded-lg p-4 border border-border-subtle"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-text-primary">{group.name}</span>
                          <span className="text-xs text-text-muted">
                            {group.repositoryIds.length} repos
                          </span>
                        </div>
                        <button
                          className="text-text-muted hover:text-error transition-colors p-1"
                          onClick={() => handleDeleteGroup(group.id)}
                          title="Delete group"
                        >
                          <TrashIcon />
                        </button>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={group.coordinator?.status || 'stopped'} />
                          {group.coordinator?.name && (
                            <span className="text-sm text-text-secondary">
                              {group.coordinator.name}
                            </span>
                          )}
                        </div>
                        <button
                          className={`py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                            group.coordinator?.enabled
                              ? 'bg-error/20 text-error hover:bg-error/30'
                              : 'bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30'
                          }`}
                          onClick={() =>
                            handleEnableCoordinator(group.id, !group.coordinator?.enabled)
                          }
                        >
                          {group.coordinator?.enabled ? 'Stop' : 'Start'} Coordinator
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Create new group form */}
              {showCreateForm ? (
                <div className="bg-bg-tertiary rounded-lg p-4 border border-accent-cyan/30">
                  <h4 className="text-sm font-semibold text-text-primary mb-4">
                    Create Project Group
                  </h4>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-text-muted mb-1.5">
                        Group Name
                      </label>
                      <input
                        type="text"
                        className="w-full py-2 px-3 bg-bg-card border border-border-subtle rounded-md text-sm text-text-primary outline-none focus:border-accent-cyan/50"
                        placeholder="e.g., Frontend Team"
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-text-muted mb-1.5">
                        Select Projects
                      </label>
                      <div className="space-y-2 max-h-[200px] overflow-y-auto">
                        {projects.map((project) => (
                          <label
                            key={project.id}
                            className="flex items-center gap-2 p-2 bg-bg-card rounded-md cursor-pointer hover:bg-bg-hover"
                          >
                            <input
                              type="checkbox"
                              className="accent-accent-cyan"
                              checked={selectedProjects.has(project.id)}
                              onChange={() => toggleProject(project.id)}
                            />
                            <span className="text-sm text-text-primary">
                              {project.name || project.path}
                            </span>
                          </label>
                        ))}
                        {projects.length === 0 && (
                          <p className="text-sm text-text-muted py-4 text-center">
                            No projects available. Add workspaces first.
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex justify-end gap-2">
                      <button
                        className="py-2 px-4 bg-transparent border border-border-subtle rounded-md text-sm text-text-secondary hover:bg-bg-hover"
                        onClick={() => {
                          setShowCreateForm(false);
                          setNewGroupName('');
                          setSelectedProjects(new Set());
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="py-2 px-4 bg-accent-cyan text-bg-deep rounded-md text-sm font-medium hover:bg-accent-cyan/90 disabled:opacity-50"
                        onClick={handleCreateGroup}
                        disabled={!newGroupName.trim() || selectedProjects.size === 0 || isLoading}
                      >
                        Create Group
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  className="w-full py-3 px-4 border-2 border-dashed border-border-subtle rounded-lg text-text-muted hover:border-accent-cyan/50 hover:text-accent-cyan transition-colors flex items-center justify-center gap-2"
                  onClick={() => setShowCreateForm(true)}
                >
                  <PlusIcon />
                  Create Project Group
                </button>
              )}

              {/* Info box */}
              <div className="mt-6 p-4 bg-bg-tertiary/50 rounded-lg border border-border-subtle">
                <h4 className="text-sm font-semibold text-text-primary mb-2 flex items-center gap-2">
                  <InfoIcon />
                  What is a Coordinator?
                </h4>
                <p className="text-sm text-text-secondary">
                  A coordinator is a high-level AI agent that oversees multiple projects. It can
                  delegate tasks to project leads, ensure consistency across codebases, and manage
                  cross-project dependencies.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    stopped: 'bg-text-muted/20 text-text-muted',
    starting: 'bg-accent-orange/20 text-accent-orange',
    running: 'bg-success/20 text-success',
    error: 'bg-error/20 text-error',
  };

  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || colors.stopped}`}>
      {status}
    </span>
  );
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin h-6 w-6 text-accent-cyan" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="32"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CoordinatorIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-cyan">
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="5" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <line x1="9.5" y1="9.5" x2="6.5" y2="6.5" />
      <line x1="14.5" y1="9.5" x2="17.5" y2="6.5" />
      <line x1="9.5" y1="14.5" x2="6.5" y2="17.5" />
      <line x1="14.5" y1="14.5" x2="17.5" y2="17.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent-cyan">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-success">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
