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

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Nango from '@nangohq/frontend';

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
  const [isGitHubNotConnected, setIsGitHubNotConnected] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'with-workspace' | 'without-workspace'>('all');

  // GitHub OAuth state
  const nangoRef = useRef<InstanceType<typeof Nango> | null>(null);
  const [isNangoReady, setIsNangoReady] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

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
    setIsGitHubNotConnected(false);

    try {
      const response = await fetch('/api/repos/accessible?perPage=100', {
        credentials: 'include',
      });

      if (!response.ok) {
        const data = await response.json();
        if (data.code === 'NANGO_NOT_CONNECTED') {
          setIsGitHubNotConnected(true);
          throw new Error('GitHub not connected. Connect your GitHub account to see your repositories.');
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

  // Initialize Nango when GitHub is not connected
  useEffect(() => {
    if (!isGitHubNotConnected) return;

    let mounted = true;

    const initNango = async () => {
      try {
        // Get Nango session token for GitHub login
        const response = await fetch('/api/auth/nango/login-session', {
          credentials: 'include',
        });
        const data = await response.json();

        if (!mounted) return;

        if (response.ok && data.sessionToken) {
          nangoRef.current = new Nango({ connectSessionToken: data.sessionToken });
          setIsNangoReady(true);
        }
      } catch (err) {
        console.error('Failed to initialize Nango:', err);
      }
    };

    initNango();
    return () => { mounted = false; };
  }, [isGitHubNotConnected]);

  // Handle GitHub OAuth connection
  const handleConnectGitHub = async () => {
    if (!nangoRef.current) {
      setConnectError('GitHub connection not available. Please refresh the page.');
      return;
    }

    setIsConnecting(true);
    setConnectError(null);

    try {
      const result = await nangoRef.current.auth('github');
      if (result && 'connectionId' in result) {
        // Poll for auth completion
        const pollForAuth = async (attempts = 0): Promise<void> => {
          if (attempts > 30) {
            throw new Error('Authentication timed out. Please try again.');
          }

          const statusRes = await fetch(`/api/auth/nango/login-status/${result.connectionId}`, {
            credentials: 'include',
          });
          const statusData = await statusRes.json();

          if (statusData.ready) {
            // Auth complete, refresh repos
            setIsConnecting(false);
            setIsGitHubNotConnected(false);
            fetchRepos();
            return;
          }

          await new Promise(resolve => setTimeout(resolve, 1000));
          return pollForAuth(attempts + 1);
        };

        await pollForAuth();
      } else {
        throw new Error('No connection ID returned');
      }
    } catch (err: unknown) {
      const error = err as Error & { type?: string };
      console.error('GitHub auth error:', error);

      // Don't show error for user-cancelled auth
      if (error.type === 'user_cancelled' || error.message?.includes('closed')) {
        setIsConnecting(false);
        // Re-initialize Nango for next attempt
        fetch('/api/auth/nango/login-session', { credentials: 'include' })
          .then(res => res.json())
          .then(data => {
            if (data.sessionToken) {
              nangoRef.current = new Nango({ connectSessionToken: data.sessionToken });
            }
          });
        return;
      }

      setConnectError(error.message || 'Failed to connect GitHub');
      setIsConnecting(false);
    }
  };

  // Create workspace for a repo
  const handleCreateWorkspace = useCallback(async (repoFullName: string) => {
    setCreatingWorkspace(repoFullName);
    setError(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch('/api/workspaces/quick', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ repositoryFullName: repoFullName }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create workspace');
      }

      onWorkspaceCreated?.(data.workspaceId, repoFullName);
    } catch (err) {
      console.error('Error creating workspace:', err);
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setCreatingWorkspace(null);
    }
  }, [csrfToken, onWorkspaceCreated]);

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

  // Error state - special handling for GitHub not connected
  if (loadingState === 'error') {
    if (isGitHubNotConnected) {
      return (
        <div className={`p-6 ${className}`}>
          <div className="bg-bg-tertiary border border-border-subtle rounded-xl p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 bg-bg-hover rounded-full flex items-center justify-center">
              <GitHubIcon className="w-8 h-8 text-text-muted" />
            </div>
            <h3 className="text-lg font-semibold text-text-primary mb-2">Connect GitHub</h3>
            <p className="text-text-muted mb-6 max-w-md mx-auto">
              Connect your GitHub account to see your repositories and enable agent access to your code.
            </p>
            {connectError && (
              <p className="text-error text-sm mb-4">{connectError}</p>
            )}
            <button
              onClick={handleConnectGitHub}
              disabled={!isNangoReady || isConnecting}
              className="px-6 py-3 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-medium rounded-lg hover:shadow-glow-cyan transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isConnecting ? (
                <span className="flex items-center gap-2">
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Connecting...
                </span>
              ) : !isNangoReady ? (
                <span className="flex items-center gap-2">
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Loading...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <GitHubIcon className="w-5 h-5" />
                  Connect GitHub Account
                </span>
              )}
            </button>
          </div>
        </div>
      );
    }

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
                        onClick={() => handleCreateWorkspace(repo.fullName)}
                        disabled={isCreating}
                        className="px-4 py-2 text-sm bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-medium rounded-lg hover:shadow-glow-cyan transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isCreating ? (
                          <span className="flex items-center gap-2">
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            Creating...
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

function GitHubIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
    </svg>
  );
}
