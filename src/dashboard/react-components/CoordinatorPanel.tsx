/**
 * CoordinatorPanel Component
 *
 * Manage bridge-level coordinator agents that oversee multiple projects.
 * Available in cloud mode for Pro+ users.
 */

import React, { useState, useEffect } from 'react';
import type { Project } from '../types';

export interface RepositoryInfo {
  id: string;
  githubFullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  workspaceId?: string;
}

export interface ProjectGroup {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  repositoryCount: number;
  repositories: RepositoryInfo[];
  coordinatorAgent?: {
    enabled: boolean;
    name?: string;
    model?: string;
    systemPrompt?: string;
    capabilities?: string[];
  };
  createdAt: string;
  updatedAt: string;
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
  const [ungroupedRepos, setUngroupedRepos] = useState<RepositoryInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [isSpawningArchitect, setIsSpawningArchitect] = useState(false);
  const [selectedCli, setSelectedCli] = useState('claude');
  const [editingGroup, setEditingGroup] = useState<ProjectGroup | null>(null);
  const [addingReposToGroupId, setAddingReposToGroupId] = useState<string | null>(null);
  const [reposToAdd, setReposToAdd] = useState<Set<string>>(new Set());

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
        setUngroupedRepos(data.ungroupedRepositories || []);
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to load project groups');
      }
    } catch (_err) {
      setError('Failed to load project groups');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!newGroupName.trim() || selectedRepos.size === 0) return;

    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/project-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newGroupName.trim(),
          description: newGroupDescription.trim() || undefined,
          repositoryIds: Array.from(selectedRepos),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.group) {
          // Add the new group and remove selected repos from ungrouped
          setProjectGroups((prev) => [...prev, data.group]);
          setUngroupedRepos((prev) => prev.filter(r => !selectedRepos.has(r.id)));
          setShowCreateForm(false);
          setNewGroupName('');
          setNewGroupDescription('');
          setSelectedRepos(new Set());
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to create project group');
      }
    } catch (_err) {
      setError('Failed to create project group');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateGroup = async (groupId: string, updates: { name?: string; description?: string }) => {
    setError(null);
    try {
      const response = await fetch(`/api/project-groups/${groupId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.group) {
          setProjectGroups((prev) =>
            prev.map((g) => (g.id === groupId ? { ...g, ...data.group } : g))
          );
          setEditingGroup(null);
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to update project group');
      }
    } catch (_err) {
      setError('Failed to update project group');
    }
  };

  const handleEnableCoordinator = async (groupId: string, enable: boolean) => {
    setError(null);
    try {
      const endpoint = `/api/project-groups/${groupId}/coordinator/${enable ? 'enable' : 'disable'}`;
      const response = await fetch(endpoint, { method: 'POST' });

      if (response.ok) {
        const data = await response.json();
        setProjectGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  coordinatorAgent: {
                    ...g.coordinatorAgent,
                    enabled: enable,
                    name: data.coordinator?.name || g.coordinatorAgent?.name,
                  },
                }
              : g
          )
        );
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || `Failed to ${enable ? 'enable' : 'disable'} coordinator`);
      }
    } catch (_err) {
      setError(`Failed to ${enable ? 'enable' : 'disable'} coordinator`);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!window.confirm('Delete this project group? The coordinator will be stopped and repositories will be ungrouped.')) {
      return;
    }

    try {
      // Find the group to get its repos before deletion
      const groupToDelete = projectGroups.find(g => g.id === groupId);

      const response = await fetch(`/api/project-groups/${groupId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        setProjectGroups((prev) => prev.filter((g) => g.id !== groupId));
        // Add the repos back to ungrouped
        if (groupToDelete?.repositories) {
          setUngroupedRepos((prev) => [...prev, ...groupToDelete.repositories]);
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to delete project group');
      }
    } catch (_err) {
      setError('Failed to delete project group');
    }
  };

  const handleRemoveRepoFromGroup = async (groupId: string, repoId: string) => {
    try {
      const response = await fetch(`/api/project-groups/${groupId}/repositories/${repoId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        // Move repo from group to ungrouped
        const group = projectGroups.find(g => g.id === groupId);
        const removedRepo = group?.repositories.find(r => r.id === repoId);

        setProjectGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  repositories: g.repositories.filter(r => r.id !== repoId),
                  repositoryCount: g.repositoryCount - 1,
                }
              : g
          )
        );

        if (removedRepo) {
          setUngroupedRepos((prev) => [...prev, removedRepo]);
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to remove repository from group');
      }
    } catch (_err) {
      setError('Failed to remove repository from group');
    }
  };

  const handleAddReposToGroup = async (groupId: string, repoIds: string[]) => {
    if (repoIds.length === 0) return;

    try {
      const response = await fetch(`/api/project-groups/${groupId}/repositories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryIds: repoIds }),
      });

      if (response.ok) {
        // Refetch to get updated data
        await fetchProjectGroups();
        setAddingReposToGroupId(null);
        setReposToAdd(new Set());
      } else {
        const errorData = await response.json().catch(() => ({}));
        setError(errorData.error || 'Failed to add repositories to group');
      }
    } catch (_err) {
      setError('Failed to add repositories to group');
    }
  };

  const toggleRepoToAdd = (repoId: string) => {
    setReposToAdd((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  };

  const toggleRepo = (repoId: string) => {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
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
    } catch (_err) {
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
                            {group.repositoryCount} {group.repositoryCount === 1 ? 'repo' : 'repos'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            className="text-text-muted hover:text-accent-cyan transition-colors p-1"
                            onClick={() => setEditingGroup(group)}
                            title="Edit group"
                          >
                            <EditIcon />
                          </button>
                          <button
                            className="text-text-muted hover:text-error transition-colors p-1"
                            onClick={() => handleDeleteGroup(group.id)}
                            title="Delete group"
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      </div>

                      {/* Show repositories in the group */}
                      {group.repositories.length > 0 && (
                        <div className="mb-3 space-y-1">
                          {group.repositories.map((repo) => (
                            <div
                              key={repo.id}
                              className="flex items-center justify-between py-1 px-2 bg-bg-card/50 rounded text-xs"
                            >
                              <span className="text-text-secondary font-mono">
                                {repo.githubFullName}
                              </span>
                              <button
                                className="text-text-muted hover:text-error transition-colors p-0.5"
                                onClick={() => handleRemoveRepoFromGroup(group.id, repo.id)}
                                title="Remove from group"
                              >
                                <CloseIcon size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      {group.description && (
                        <p className="text-xs text-text-muted mb-3">{group.description}</p>
                      )}

                      {/* Add repos to group section */}
                      {addingReposToGroupId === group.id ? (
                        <div className="mb-3 p-3 bg-bg-card rounded-lg border border-border-subtle">
                          <div className="text-xs font-medium text-text-muted mb-2">
                            Select repositories to add:
                          </div>
                          <div className="space-y-1 max-h-[150px] overflow-y-auto mb-3">
                            {ungroupedRepos.length > 0 ? (
                              ungroupedRepos.map((repo) => (
                                <label
                                  key={repo.id}
                                  className="flex items-center gap-2 p-1.5 rounded cursor-pointer hover:bg-bg-hover"
                                >
                                  <input
                                    type="checkbox"
                                    className="accent-accent-cyan"
                                    checked={reposToAdd.has(repo.id)}
                                    onChange={() => toggleRepoToAdd(repo.id)}
                                  />
                                  <span className="text-xs text-text-primary font-mono">
                                    {repo.githubFullName}
                                  </span>
                                </label>
                              ))
                            ) : (
                              <p className="text-xs text-text-muted py-2 text-center">
                                No ungrouped repositories available
                              </p>
                            )}
                          </div>
                          <div className="flex justify-end gap-2">
                            <button
                              className="py-1 px-3 text-xs bg-transparent border border-border-subtle rounded text-text-secondary hover:bg-bg-hover"
                              onClick={() => {
                                setAddingReposToGroupId(null);
                                setReposToAdd(new Set());
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              className="py-1 px-3 text-xs bg-accent-cyan text-bg-deep rounded font-medium hover:bg-accent-cyan/90 disabled:opacity-50"
                              onClick={() => handleAddReposToGroup(group.id, Array.from(reposToAdd))}
                              disabled={reposToAdd.size === 0}
                            >
                              Add Selected
                            </button>
                          </div>
                        </div>
                      ) : ungroupedRepos.length > 0 ? (
                        <button
                          className="mb-3 w-full py-1.5 text-xs border border-dashed border-border-subtle rounded text-text-muted hover:border-accent-cyan/50 hover:text-accent-cyan transition-colors flex items-center justify-center gap-1"
                          onClick={() => {
                            setAddingReposToGroupId(group.id);
                            setReposToAdd(new Set());
                          }}
                        >
                          <PlusIcon />
                          Add repositories
                        </button>
                      ) : null}

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={group.coordinatorAgent?.enabled ? 'running' : 'stopped'} />
                          {group.coordinatorAgent?.name && (
                            <span className="text-sm text-text-secondary">
                              {group.coordinatorAgent.name}
                            </span>
                          )}
                        </div>
                        <button
                          className={`py-1.5 px-3 rounded-md text-xs font-medium transition-colors ${
                            group.coordinatorAgent?.enabled
                              ? 'bg-error/20 text-error hover:bg-error/30'
                              : 'bg-accent-cyan/20 text-accent-cyan hover:bg-accent-cyan/30'
                          } ${group.repositoryCount === 0 ? 'opacity-50 cursor-not-allowed' : ''}`}
                          onClick={() =>
                            group.repositoryCount > 0 &&
                            handleEnableCoordinator(group.id, !group.coordinatorAgent?.enabled)
                          }
                          disabled={group.repositoryCount === 0}
                          title={group.repositoryCount === 0 ? 'Add repositories first' : undefined}
                        >
                          {group.coordinatorAgent?.enabled ? 'Stop' : 'Start'} Coordinator
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Edit group modal */}
              {editingGroup && (
                <div className="bg-bg-tertiary rounded-lg p-4 border border-accent-cyan/30 mb-4">
                  <h4 className="text-sm font-semibold text-text-primary mb-4">
                    Edit Project Group
                  </h4>
                  <EditGroupForm
                    group={editingGroup}
                    onSave={(updates) => handleUpdateGroup(editingGroup.id, updates)}
                    onCancel={() => setEditingGroup(null)}
                  />
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
                        Description (optional)
                      </label>
                      <input
                        type="text"
                        className="w-full py-2 px-3 bg-bg-card border border-border-subtle rounded-md text-sm text-text-primary outline-none focus:border-accent-cyan/50"
                        placeholder="e.g., All frontend repositories"
                        value={newGroupDescription}
                        onChange={(e) => setNewGroupDescription(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-text-muted mb-1.5">
                        Select Repositories
                      </label>
                      <div className="space-y-2 max-h-[200px] overflow-y-auto">
                        {ungroupedRepos.map((repo) => (
                          <label
                            key={repo.id}
                            className="flex items-center gap-2 p-2 bg-bg-card rounded-md cursor-pointer hover:bg-bg-hover"
                          >
                            <input
                              type="checkbox"
                              className="accent-accent-cyan"
                              checked={selectedRepos.has(repo.id)}
                              onChange={() => toggleRepo(repo.id)}
                            />
                            <span className="text-sm text-text-primary font-mono">
                              {repo.githubFullName}
                            </span>
                            {repo.isPrivate && (
                              <span className="text-xs text-text-muted">🔒</span>
                            )}
                          </label>
                        ))}
                        {ungroupedRepos.length === 0 && (
                          <p className="text-sm text-text-muted py-4 text-center">
                            No ungrouped repositories. Add repositories in Settings or ungroup existing ones.
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
                          setNewGroupDescription('');
                          setSelectedRepos(new Set());
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="py-2 px-4 bg-accent-cyan text-bg-deep rounded-md text-sm font-medium hover:bg-accent-cyan/90 disabled:opacity-50"
                        onClick={handleCreateGroup}
                        disabled={!newGroupName.trim() || selectedRepos.size === 0 || isLoading}
                      >
                        {isLoading ? 'Creating...' : 'Create Group'}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <button
                  className="w-full py-3 px-4 border-2 border-dashed border-border-subtle rounded-lg text-text-muted hover:border-accent-cyan/50 hover:text-accent-cyan transition-colors flex items-center justify-center gap-2"
                  onClick={() => setShowCreateForm(true)}
                  disabled={!!editingGroup}
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

function CloseIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
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

interface EditGroupFormProps {
  group: ProjectGroup;
  onSave: (updates: { name?: string; description?: string }) => void;
  onCancel: () => void;
}

function EditGroupForm({ group, onSave, onCancel }: EditGroupFormProps) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description || '');

  const handleSave = () => {
    const updates: { name?: string; description?: string } = {};
    if (name.trim() !== group.name) {
      updates.name = name.trim();
    }
    if (description.trim() !== (group.description || '')) {
      updates.description = description.trim();
    }
    if (Object.keys(updates).length > 0) {
      onSave(updates);
    } else {
      onCancel();
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-text-muted mb-1.5">
          Group Name
        </label>
        <input
          type="text"
          className="w-full py-2 px-3 bg-bg-card border border-border-subtle rounded-md text-sm text-text-primary outline-none focus:border-accent-cyan/50"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-text-muted mb-1.5">
          Description
        </label>
        <input
          type="text"
          className="w-full py-2 px-3 bg-bg-card border border-border-subtle rounded-md text-sm text-text-primary outline-none focus:border-accent-cyan/50"
          placeholder="Optional description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="flex justify-end gap-2">
        <button
          className="py-2 px-4 bg-transparent border border-border-subtle rounded-md text-sm text-text-secondary hover:bg-bg-hover"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          className="py-2 px-4 bg-accent-cyan text-bg-deep rounded-md text-sm font-medium hover:bg-accent-cyan/90 disabled:opacity-50"
          onClick={handleSave}
          disabled={!name.trim()}
        >
          Save Changes
        </button>
      </div>
    </div>
  );
}
