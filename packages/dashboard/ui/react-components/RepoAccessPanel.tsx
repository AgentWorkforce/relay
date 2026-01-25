/**
 * RepoAccessPanel - GitHub Repository Access Management
 *
 * Shows repositories the user has GitHub access to with permission levels.
 * Allows creating workspaces to enable dashboard/chat access per repo.
 *
 * Uses:
 * - GET /api/repos/accessible - List repos user can access via GitHub OAuth
 * - POST /api/workspaces/quick - Create workspace for a repo
 */

import React, { useState, useEffect, useCallback } from 'react';

interface AccessibleRepo {
  id: number;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  permissions: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
}

interface Workspace {
  id: string;
  name: string;
  repositoryFullName?: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
}

export interface RepoAccessPanelProps {
  /** Existing workspaces to show which repos have dashboard access */
  workspaces?: Workspace[];
  /** Callback when a workspace is created */
  onWorkspaceCreated?: (workspaceId: string, repoFullName: string) => void;
  /** Callback when user wants to open a workspace */
  onOpenWorkspace?: (workspaceId: string) => void;
  /** CSRF token for mutations */
  csrfToken?: string;
  /** Custom class name */
  className?: string;
}

type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

function getPermissionLevel(permissions: { admin: boolean; push: boolean; pull: boolean }): {
  level: 'admin' | 'write' | 'read';
  label: string;
  color: string;
} {
  if (permissions.admin) {
    return { level: 'admin', label: 'Admin', color: 'text-accent-purple bg-accent-purple/10 border-accent-purple/30' };
  }
  if (permissions.push) {
    return { level: 'write', label: 'Write', color: 'text-accent-cyan bg-accent-cyan/10 border-accent-cyan/30' };
  }
  return { level: 'read', label: 'Read', color: 'text-text-muted bg-bg-tertiary border-border-subtle' };
}

export function RepoAccessPanel({
  workspaces = [],
  onWorkspaceCreated,
  onOpenWorkspace,
  csrfToken,
  className = '',
}: RepoAccessPanelProps) {
  const [repos, setRepos] = useState<AccessibleRepo[]>([]);
  const [loadingState, setLoadingState] = useState<LoadingState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [creatingWorkspace, setCreatingWorkspace] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'with-workspace' | 'without-workspace'>('all');
  
  // OAuth flow state
  const [oauthRepo, setOauthRepo] = useState<string | null>(null);
  const [oauthSessionToken, setOauthSessionToken] = useState<string | null>(null);
  const [oauthConnectionId, setOauthConnectionId] = useState<string | null>(null);
  
  // Workspace choice modal state
  const [workspaceChoice, setWorkspaceChoice] = useState<{
    repoFullName: string;
    workspaces: Array<{ id: string; name: string; repoCount: number }>;
  } | null>(null);

  // Create a map of repo full names to workspace IDs for quick lookup
  const repoToWorkspace = new Map<string, Workspace>();
  workspaces.forEach(ws => {
    if (ws.repositoryFullName) {
      repoToWorkspace.set(ws.repositoryFullName, ws);
    }
  });

  // Fetch accessible repos
  const fetchRepos = useCallback(async () => {
    setLoadingState('loading');
    setError(null);

    try {
      const response = await fetch('/api/repos/accessible?perPage=100', {
        credentials: 'include',
      });

      if (!response.ok) {
        const data = await response.json();
        if (data.code === 'NANGO_NOT_CONNECTED') {
          throw new Error('GitHub not connected. Please reconnect your GitHub account.');
        }
        throw new Error(data.error || 'Failed to fetch repositories');
      }

      const data = await response.json();
      setRepos(data.repositories || []);
      setLoadingState('loaded');
    } catch (err) {
      console.error('Error fetching accessible repos:', err);
      setError(err instanceof Error ? err.message : 'Failed to load repositories');
      setLoadingState('error');
    }
  }, []);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  // Enable access to a repo (handles OAuth, workspace choice, cloning)
  const handleEnableAccess = useCallback(async (repoFullName: string, targetWorkspaceId?: string, createNew?: boolean) => {
    setCreatingWorkspace(repoFullName);
    setError(null);
    setOauthRepo(null);
    setWorkspaceChoice(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch('/api/workspaces/enable-repo', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ 
          repositoryFullName: repoFullName,
          workspaceId: targetWorkspaceId,
          createNew,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to enable repository access');
      }

      // Handle OAuth requirement
      if (data.requiresOAuth) {
        if (data.oauthType === 'github-app') {
          setOauthRepo(repoFullName);
          setOauthSessionToken(data.sessionToken);
          // Open Nango connect UI
          const nangoUrl = `https://app.nango.dev/connect/${data.sessionToken}`;
          window.open(nangoUrl, 'nango-oauth', 'width=600,height=700');
          
          // Start polling for completion
          pollOAuthStatus(repoFullName, data.sessionToken);
        } else {
          throw new Error('GitHub not connected. Please connect your GitHub account first.');
        }
        return;
      }

      // Handle workspace choice requirement
      if (data.requiresWorkspaceChoice) {
        setWorkspaceChoice({
          repoFullName: data.repositoryFullName,
          workspaces: data.suggestedWorkspaces,
        });
        setCreatingWorkspace(null);
        return;
      }

      // Success - repo enabled
      if (data.success) {
        onWorkspaceCreated?.(data.workspaceId, repoFullName);
        
        // Refresh repos list to show updated status
        setTimeout(() => {
          fetchRepos();
        }, 1000);
      }
    } catch (err) {
      console.error('Error enabling repo access:', err);
      setError(err instanceof Error ? err.message : 'Failed to enable repository access');
    } finally {
      if (!oauthRepo && !workspaceChoice) {
        setCreatingWorkspace(null);
      }
    }
  }, [csrfToken, onWorkspaceCreated, fetchRepos]);

  // Poll for OAuth completion
  const pollOAuthStatus = useCallback(async (repoFullName: string, sessionToken: string) => {
    const maxAttempts = 60; // 5 minutes max
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        setError('OAuth timeout - please try again');
        setOauthRepo(null);
        setOauthSessionToken(null);
        setCreatingWorkspace(null);
        return;
      }

      attempts++;

      try {
        // Get connection ID from Nango session first
        // We need to check the repo-status endpoint which uses connectionId
        // For now, poll the enable-repo endpoint again to check status
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (csrfToken) {
          headers['X-CSRF-Token'] = csrfToken;
        }

        const response = await fetch('/api/workspaces/enable-repo', {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ repositoryFullName: repoFullName }),
        });

        const data = await response.json();

        if (data.requiresOAuth && data.oauthType === 'github-app') {
          // Still needs OAuth - keep polling
          setTimeout(poll, 5000);
        } else if (data.requiresWorkspaceChoice) {
          // OAuth complete, now needs workspace choice
          setOauthRepo(null);
          setOauthSessionToken(null);
          setWorkspaceChoice({
            repoFullName: data.repositoryFullName,
            workspaces: data.suggestedWorkspaces,
          });
          setCreatingWorkspace(null);
        } else if (data.success) {
          // Success!
          setOauthRepo(null);
          setOauthSessionToken(null);
          setCreatingWorkspace(null);
          onWorkspaceCreated?.(data.workspaceId, repoFullName);
          setTimeout(() => {
            fetchRepos();
          }, 1000);
        } else {
          // Error
          setError(data.error || 'Failed to enable repository access');
          setOauthRepo(null);
          setOauthSessionToken(null);
          setCreatingWorkspace(null);
        }
      } catch (err) {
        console.error('Error polling OAuth status:', err);
        setTimeout(poll, 5000);
      }
    };

    poll();
  }, [csrfToken, handleEnableAccess, onWorkspaceCreated, fetchRepos]);

  // Handle workspace choice
  const handleChooseWorkspace = useCallback(async (workspaceId: string) => {
    if (!workspaceChoice) return;
    
    await handleEnableAccess(workspaceChoice.repoFullName, workspaceId);
    setWorkspaceChoice(null);
  }, [workspaceChoice, handleEnableAccess]);

  // Create new workspace (from choice modal)
  const handleCreateNewWorkspace = useCallback(async () => {
    if (!workspaceChoice) return;
    
    // Pass createNew=true to skip workspace choice and force new workspace creation
    await handleEnableAccess(workspaceChoice.repoFullName, undefined, true);
    setWorkspaceChoice(null);
  }, [workspaceChoice, handleEnableAccess]);

  // Filter repos based on search and filter type
  const filteredRepos = repos.filter(repo => {
    // Search filter
    if (searchQuery && !repo.fullName.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false;
    }

    // Workspace filter
    const hasWorkspace = repoToWorkspace.has(repo.fullName);
    if (filterType === 'with-workspace' && !hasWorkspace) return false;
    if (filterType === 'without-workspace' && hasWorkspace) return false;

    return true;
  });

  // Loading state
  if (loadingState === 'loading') {
    return (
      <div className={`flex items-center justify-center py-12 ${className}`}>
        <div className="text-center">
          <svg className="w-8 h-8 text-accent-cyan animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="mt-4 text-text-muted">Loading repositories...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (loadingState === 'error') {
    return (
      <div className={`p-6 ${className}`}>
        <div className="bg-error/10 border border-error/20 rounded-xl p-4 text-center">
          <div className="w-12 h-12 mx-auto mb-3 bg-error/20 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <p className="text-error mb-4">{error}</p>
          <button
            onClick={fetchRepos}
            className="px-4 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary hover:bg-bg-hover transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Header */}
      <div className="p-4 border-b border-border-subtle">
        <h2 className="text-lg font-semibold text-text-primary mb-1">Repository Access</h2>
        <p className="text-sm text-text-muted">
          Repositories you have access to on GitHub. Create workspaces to enable dashboard and chat access.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      {/* Search and filters */}
      <div className="p-4 border-b border-border-subtle">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="flex-1 relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Search repositories..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-cyan/50 transition-colors"
            />
          </div>

          {/* Filter */}
          <div className="flex gap-2">
            <button
              onClick={() => setFilterType('all')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                filterType === 'all'
                  ? 'bg-accent-cyan/10 border-accent-cyan/30 text-accent-cyan'
                  : 'bg-bg-tertiary border-border-subtle text-text-muted hover:text-text-primary'
              }`}
            >
              All ({repos.length})
            </button>
            <button
              onClick={() => setFilterType('with-workspace')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                filterType === 'with-workspace'
                  ? 'bg-success/10 border-success/30 text-success'
                  : 'bg-bg-tertiary border-border-subtle text-text-muted hover:text-text-primary'
              }`}
            >
              With Access
            </button>
            <button
              onClick={() => setFilterType('without-workspace')}
              className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                filterType === 'without-workspace'
                  ? 'bg-warning/10 border-warning/30 text-warning'
                  : 'bg-bg-tertiary border-border-subtle text-text-muted hover:text-text-primary'
              }`}
            >
              No Access
            </button>
          </div>
        </div>
      </div>

      {/* Repo list */}
      <div className="max-h-[500px] overflow-y-auto">
        {filteredRepos.length === 0 ? (
          <div className="py-12 text-center text-text-muted">
            {searchQuery ? (
              <p>No repositories match "{searchQuery}"</p>
            ) : filterType !== 'all' ? (
              <p>No repositories in this category</p>
            ) : (
              <p>No repositories found. Connect your GitHub account to see your repos.</p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {filteredRepos.map((repo) => {
              const permission = getPermissionLevel(repo.permissions);
              const workspace = repoToWorkspace.get(repo.fullName);
              const isCreating = creatingWorkspace === repo.fullName;

              return (
                <div
                  key={repo.id}
                  className="flex items-center gap-4 p-4 hover:bg-bg-hover/50 transition-colors"
                >
                  {/* Repo icon */}
                  <div className="w-10 h-10 rounded-lg bg-bg-tertiary border border-border-subtle flex items-center justify-center flex-shrink-0">
                    <RepoIcon className="text-text-muted" />
                  </div>

                  {/* Repo info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="font-medium text-text-primary truncate">{repo.fullName}</p>
                      {repo.isPrivate && (
                        <span className="px-1.5 py-0.5 text-xs bg-bg-tertiary border border-border-subtle rounded text-text-muted">
                          Private
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full border ${permission.color}`}>
                        {permission.label}
                      </span>
                      <span className="text-xs text-text-muted">{repo.defaultBranch}</span>
                    </div>
                  </div>

                  {/* Action button */}
                  <div className="flex-shrink-0">
                    {workspace ? (
                      <button
                        onClick={() => onOpenWorkspace?.(workspace.id)}
                        className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
                          workspace.status === 'running'
                            ? 'bg-success/10 border-success/30 text-success hover:bg-success/20'
                            : workspace.status === 'provisioning'
                            ? 'bg-accent-cyan/10 border-accent-cyan/30 text-accent-cyan'
                            : 'bg-bg-tertiary border-border-subtle text-text-muted hover:bg-bg-hover'
                        }`}
                      >
                        {workspace.status === 'running' ? 'Open Dashboard' :
                         workspace.status === 'provisioning' ? 'Starting...' :
                         workspace.status === 'stopped' ? 'Start' : 'View'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleEnableAccess(repo.fullName)}
                        disabled={isCreating || oauthRepo === repo.fullName}
                        className="px-4 py-2 text-sm bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-medium rounded-lg hover:shadow-glow-cyan transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isCreating || oauthRepo === repo.fullName ? (
                          <span className="flex items-center gap-2">
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            {oauthRepo === repo.fullName ? 'Authorizing...' : 'Starting...'}
                          </span>
                        ) : (
                          'Enable Access'
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-border-subtle bg-bg-tertiary/50">
        <p className="text-xs text-text-muted text-center">
          Showing {filteredRepos.length} of {repos.length} repositories you have GitHub access to.
          <button
            onClick={fetchRepos}
            className="ml-2 text-accent-cyan hover:underline"
          >
            Refresh
          </button>
        </p>
      </div>

      {/* Workspace Choice Modal */}
      {workspaceChoice && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] backdrop-blur-sm">
          <div className="bg-[#1a1a2e] border border-[#3a3a4e] rounded-xl p-6 min-w-[500px] max-w-[90vw] shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
            <h3 className="text-lg font-semibold text-[#e8e8e8] mb-2">
              Add to Existing Workspace?
            </h3>
            <p className="text-sm text-[#999] mb-4">
              Found {workspaceChoice.workspaces.length} workspace(s) with repositories from the same organization. 
              Add <code className="px-1.5 py-0.5 bg-[#2a2a3e] rounded text-xs">{workspaceChoice.repoFullName}</code> to an existing workspace?
            </p>
            
            <div className="space-y-2 mb-4 max-h-[300px] overflow-y-auto">
              {workspaceChoice.workspaces.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => handleChooseWorkspace(ws.id)}
                  className="w-full p-3 bg-[#2a2a3e] border border-[#3a3a4e] rounded-lg hover:border-accent-cyan/50 transition-colors text-left"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-[#e8e8e8]">{ws.name}</p>
                      <p className="text-xs text-[#999]">{ws.repoCount} repository{ws.repoCount !== 1 ? 'ies' : 'y'}</p>
                    </div>
                    <span className="text-accent-cyan text-sm">Add →</span>
                  </div>
                </button>
              ))}
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setWorkspaceChoice(null);
                  setCreatingWorkspace(null);
                }}
                className="px-4 py-2 rounded-md text-sm font-medium cursor-pointer transition-all bg-transparent border border-[#3a3a4e] text-[#e8e8e8] hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateNewWorkspace}
                className="px-4 py-2 rounded-md text-sm font-medium cursor-pointer transition-all bg-[#00c896] border-none text-[#1a1a2e] hover:bg-[#00a87d]"
              >
                Create New Workspace
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OAuth Status Banner */}
      {oauthRepo && (
        <div className="fixed bottom-4 right-4 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg p-4 max-w-md z-[10000]">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-accent-cyan">Authorizing GitHub App</p>
              <p className="text-xs text-text-muted mt-0.5">
                Complete the authorization in the popup window
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Icons
function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function RepoIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
    </svg>
  );
}
