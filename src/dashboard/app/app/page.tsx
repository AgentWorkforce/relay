/**
 * Dashboard V2 - Main App Page
 *
 * In cloud mode: Shows workspace selection and connects to selected workspace's dashboard.
 * In local mode: Connects to local daemon WebSocket.
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { App } from '../../react-components/App';
import { LogoIcon } from '../../react-components/Logo';
import { setActiveWorkspaceId } from '../../lib/api';

interface Workspace {
  id: string;
  name: string;
  status: 'provisioning' | 'running' | 'stopped' | 'error';
  publicUrl?: string;
  providers?: string[];
  repositories?: string[];
  createdAt: string;
}

interface Repository {
  id: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  syncStatus: string;
  hasNangoConnection: boolean;
}

interface ProviderInfo {
  id: string;
  name: string;
  displayName: string;
  color: string;
  cliCommand?: string;
}

interface ProviderAuthState {
  provider: ProviderInfo;
  authUrl?: string;
  status: 'starting' | 'waiting' | 'success' | 'error';
  error?: string;
}

type PageState = 'loading' | 'local' | 'select-workspace' | 'no-workspaces' | 'connect-provider' | 'connecting' | 'connected' | 'error';

// Available AI providers
const AI_PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic', displayName: 'Claude', color: '#D97757', cliCommand: 'claude' },
  { id: 'codex', name: 'OpenAI', displayName: 'Codex', color: '#10A37F', cliCommand: 'codex login' },
  { id: 'opencode', name: 'OpenCode', displayName: 'OpenCode', color: '#00D4AA', cliCommand: 'opencode' },
  { id: 'droid', name: 'Factory', displayName: 'Droid', color: '#6366F1', cliCommand: 'droid' },
];

export default function DashboardPage() {
  const [state, setState] = useState<PageState>('loading');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [wsUrl, setWsUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Track cloud mode for potential future use
  const [_isCloudMode, setIsCloudMode] = useState(false);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [providerAuth, setProviderAuth] = useState<ProviderAuthState | null>(null);

  // Check if we're in cloud mode and fetch data
  useEffect(() => {
    const init = async () => {
      try {
        // Check session to determine if we're in cloud mode
        const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });

        // If session endpoint doesn't exist (404), we're in local mode
        if (sessionRes.status === 404) {
          setIsCloudMode(false);
          setState('local');
          return;
        }

        // Capture CSRF token from response header
        const token = sessionRes.headers.get('X-CSRF-Token');
        if (token) {
          setCsrfToken(token);
        }

        const session = await sessionRes.json();

        if (!session.authenticated) {
          // Cloud mode but not authenticated - redirect to login
          window.location.href = '/login';
          return;
        }

        // Cloud mode - fetch workspaces and repos
        setIsCloudMode(true);

        const [workspacesRes, reposRes] = await Promise.all([
          fetch('/api/workspaces', { credentials: 'include' }),
          fetch('/api/github-app/repos', { credentials: 'include' }),
        ]);

        if (!workspacesRes.ok) {
          if (workspacesRes.status === 401) {
            window.location.href = '/login';
            return;
          }
          throw new Error('Failed to fetch workspaces');
        }

        const workspacesData = await workspacesRes.json();
        const reposData = reposRes.ok ? await reposRes.json() : { repositories: [] };

        setWorkspaces(workspacesData.workspaces || []);
        setRepos(reposData.repositories || []);

        // Determine next state based on workspace availability
        const runningWorkspaces = (workspacesData.workspaces || []).filter(
          (w: Workspace) => w.status === 'running' && w.publicUrl
        );

        if (runningWorkspaces.length === 1) {
          // Auto-connect to the only running workspace
          connectToWorkspace(runningWorkspaces[0]);
        } else if (runningWorkspaces.length > 1) {
          setState('select-workspace');
        } else if ((workspacesData.workspaces || []).length > 0) {
          // Has workspaces but none running
          setState('select-workspace');
        } else if ((reposData.repositories || []).length > 0) {
          // Has repos but no workspaces - show create workspace
          setState('no-workspaces');
        } else {
          // No repos, no workspaces - redirect to connect repos
          window.location.href = '/connect-repos';
        }
      } catch (err) {
        // If session check fails with 404, assume local mode
        if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
          setIsCloudMode(false);
          setState('local');
          return;
        }
        console.error('Init error:', err);
        setError(err instanceof Error ? err.message : 'Failed to initialize');
        setState('error');
      }
    };

    init();
  }, []);

  const connectToWorkspace = useCallback((workspace: Workspace) => {
    if (!workspace.publicUrl) {
      setError('Workspace has no public URL');
      setState('error');
      return;
    }

    setSelectedWorkspace(workspace);
    setState('connecting');

    // Set the active workspace ID for API proxying
    setActiveWorkspaceId(workspace.id);

    // Derive WebSocket URL from public URL
    // e.g., https://workspace-abc.agentrelay.dev -> wss://workspace-abc.agentrelay.dev/ws
    const url = new URL(workspace.publicUrl);
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const derivedWsUrl = `${wsProtocol}//${url.host}/ws`;

    setWsUrl(derivedWsUrl);
    setState('connected');
  }, []);

  const handleCreateWorkspace = useCallback(async (repoFullName: string) => {
    setState('loading');
    setError(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const res = await fetch('/api/workspaces/quick', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ repositoryFullName: repoFullName }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to create workspace');
      }

      // Poll for workspace to be ready
      const pollForReady = async (workspaceId: string) => {
        const maxAttempts = 60; // 2 minutes with 2s interval
        let attempts = 0;

        while (attempts < maxAttempts) {
          const statusRes = await fetch(`/api/workspaces/${workspaceId}/status`, {
            credentials: 'include',
          });
          const statusData = await statusRes.json();

          if (statusData.status === 'running') {
            // Fetch updated workspace info
            const wsRes = await fetch(`/api/workspaces/${workspaceId}`, {
              credentials: 'include',
            });
            const wsData = await wsRes.json();
            if (wsData.publicUrl) {
              // Store workspace and show provider connection screen
              setSelectedWorkspace(wsData);
              setState('connect-provider');
              return;
            }
          } else if (statusData.status === 'error') {
            throw new Error('Workspace provisioning failed');
          }

          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
        }

        throw new Error('Workspace provisioning timed out');
      };

      await pollForReady(data.workspaceId);
    } catch (err) {
      console.error('Create workspace error:', err);
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setState('no-workspaces');
    }
  }, [connectToWorkspace, csrfToken]);

  // Handle connecting an AI provider via CLI login
  const handleConnectProvider = useCallback(async (provider: ProviderInfo) => {
    if (!selectedWorkspace) return;

    setProviderAuth({ provider, status: 'starting' });

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const res = await fetch(`/api/workspaces/${selectedWorkspace.id}/connect-provider`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ provider: provider.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to start provider auth');
      }

      if (data.authUrl) {
        // Auto-open the auth URL in a popup
        const width = 600;
        const height = 700;
        const left = window.screenX + (window.outerWidth - width) / 2;
        const top = window.screenY + (window.outerHeight - height) / 2;
        window.open(
          data.authUrl,
          `${provider.displayName} Login`,
          `width=${width},height=${height},left=${left},top=${top},popup=yes`
        );
        setProviderAuth({ provider, authUrl: data.authUrl, status: 'waiting' });
      } else {
        // No auth URL means already authenticated or error
        setProviderAuth({ provider, status: 'success' });
        // Auto-continue after 2 seconds
        setTimeout(() => {
          setProviderAuth(null);
          connectToWorkspace(selectedWorkspace);
        }, 2000);
      }
    } catch (err) {
      setProviderAuth({
        provider,
        status: 'error',
        error: err instanceof Error ? err.message : 'Failed to connect provider',
      });
    }
  }, [selectedWorkspace, csrfToken, connectToWorkspace]);

  // Skip provider connection and continue to workspace
  const handleSkipProvider = useCallback(() => {
    if (selectedWorkspace) {
      setProviderAuth(null);
      connectToWorkspace(selectedWorkspace);
    }
  }, [selectedWorkspace, connectToWorkspace]);

  const handleStartWorkspace = useCallback(async (workspace: Workspace) => {
    setState('loading');
    setError(null);

    try {
      const headers: Record<string, string> = {};
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const res = await fetch(`/api/workspaces/${workspace.id}/restart`, {
        method: 'POST',
        credentials: 'include',
        headers,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start workspace');
      }

      // Poll for workspace to be ready
      const maxAttempts = 60;
      let attempts = 0;

      while (attempts < maxAttempts) {
        const statusRes = await fetch(`/api/workspaces/${workspace.id}/status`, {
          credentials: 'include',
        });
        const statusData = await statusRes.json();

        if (statusData.status === 'running') {
          const wsRes = await fetch(`/api/workspaces/${workspace.id}`, {
            credentials: 'include',
          });
          const wsData = await wsRes.json();
          if (wsData.publicUrl) {
            connectToWorkspace({ ...workspace, ...wsData });
            return;
          }
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
      }

      throw new Error('Workspace start timed out');
    } catch (err) {
      console.error('Start workspace error:', err);
      setError(err instanceof Error ? err.message : 'Failed to start workspace');
      setState('select-workspace');
    }
  }, [connectToWorkspace, csrfToken]);

  // Loading state
  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <svg className="w-8 h-8 text-accent-cyan animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="mt-4 text-text-muted">Loading...</p>
        </div>
      </div>
    );
  }

  // Local mode - just render the App component
  if (state === 'local') {
    return <App />;
  }

  // Connected to workspace - render App with workspace's WebSocket
  if (state === 'connected' && wsUrl) {
    return <App wsUrl={wsUrl} />;
  }

  // Connecting state
  if (state === 'connecting') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <svg className="w-8 h-8 text-accent-cyan animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="mt-4 text-white font-medium">Connecting to {selectedWorkspace?.name}...</p>
          <p className="mt-2 text-text-muted text-sm">{selectedWorkspace?.publicUrl}</p>
        </div>
      </div>
    );
  }

  // Error state
  if (state === 'error') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center p-4">
        <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 mx-auto mb-4 bg-error/20 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Something went wrong</h2>
          <p className="text-text-muted mb-6">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="w-full py-3 px-4 bg-bg-tertiary border border-border-subtle rounded-xl text-white font-medium hover:bg-bg-hover transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // Connect provider state - show after workspace is ready
  if (state === 'connect-provider' && selectedWorkspace) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex flex-col items-center justify-center p-4">
        {/* Background grid */}
        <div className="fixed inset-0 opacity-10 pointer-events-none">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `linear-gradient(rgba(0, 217, 255, 0.1) 1px, transparent 1px),
                               linear-gradient(90deg, rgba(0, 217, 255, 0.1) 1px, transparent 1px)`,
              backgroundSize: '50px 50px',
            }}
          />
        </div>

        <div className="relative z-10 w-full max-w-xl">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <LogoIcon size={48} withGlow={true} />
            <h1 className="mt-4 text-2xl font-bold text-white">Connect AI Provider</h1>
            <p className="mt-2 text-text-muted text-center">
              Your workspace <span className="text-white">{selectedWorkspace.name}</span> is ready!
              <br />Connect an AI provider to start using agents.
            </p>
          </div>

          {/* Provider auth modal */}
          {providerAuth && (
            <div className="mb-6 bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                  style={{ backgroundColor: providerAuth.provider.color }}
                >
                  {providerAuth.provider.displayName[0]}
                </div>
                <div>
                  <h3 className="font-medium text-white">{providerAuth.provider.displayName}</h3>
                  <p className="text-sm text-text-muted">
                    {providerAuth.status === 'starting' && 'Starting login...'}
                    {providerAuth.status === 'waiting' && 'Complete login in the popup'}
                    {providerAuth.status === 'success' && 'Connected!'}
                    {providerAuth.status === 'error' && providerAuth.error}
                  </p>
                </div>
              </div>

              {providerAuth.status === 'waiting' && providerAuth.authUrl && (
                <div className="space-y-4">
                  <div className="flex items-center justify-center gap-3 py-4">
                    <svg className="w-5 h-5 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span className="text-white">Complete login in the popup window</span>
                  </div>
                  <p className="text-sm text-text-muted text-center">
                    A popup window should have opened. If it didn't, click below:
                  </p>
                  <a
                    href={providerAuth.authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-full py-2 px-4 bg-bg-tertiary border border-border-subtle text-white rounded-lg text-center hover:border-accent-cyan/50 transition-colors text-sm"
                  >
                    Open Login Page Manually
                  </a>
                  <button
                    onClick={() => {
                      setProviderAuth(null);
                      connectToWorkspace(selectedWorkspace);
                    }}
                    className="w-full py-3 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl text-center hover:shadow-glow-cyan transition-all"
                  >
                    I've completed login - Continue
                  </button>
                </div>
              )}

              {providerAuth.status === 'error' && (
                <button
                  onClick={() => setProviderAuth(null)}
                  className="w-full py-2 text-text-muted hover:text-white transition-colors text-sm"
                >
                  Try a different provider
                </button>
              )}
            </div>
          )}

          {/* Provider list */}
          {!providerAuth && (
            <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Choose an AI Provider</h2>
              <div className="space-y-3">
                {AI_PROVIDERS.map((provider) => (
                  <button
                    key={provider.id}
                    onClick={() => handleConnectProvider(provider)}
                    className="w-full flex items-center gap-3 p-4 bg-bg-tertiary rounded-xl border border-border-subtle hover:border-accent-cyan/50 transition-colors text-left"
                  >
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold flex-shrink-0"
                      style={{ backgroundColor: provider.color }}
                    >
                      {provider.displayName[0]}
                    </div>
                    <div className="flex-1">
                      <p className="text-white font-medium">{provider.displayName}</p>
                      <p className="text-text-muted text-sm">{provider.name}</p>
                    </div>
                    <svg className="w-5 h-5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Skip button */}
          <div className="mt-6 text-center">
            <button
              onClick={handleSkipProvider}
              className="text-text-muted hover:text-white transition-colors text-sm"
            >
              Skip for now - I'll connect later
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Workspace selection / no workspaces UI
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex flex-col items-center justify-center p-4">
      {/* Background grid */}
      <div className="fixed inset-0 opacity-10 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(rgba(0, 217, 255, 0.1) 1px, transparent 1px),
                             linear-gradient(90deg, rgba(0, 217, 255, 0.1) 1px, transparent 1px)`,
            backgroundSize: '50px 50px',
          }}
        />
      </div>

      <div className="relative z-10 w-full max-w-2xl">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <LogoIcon size={48} withGlow={true} />
          <h1 className="mt-4 text-2xl font-bold text-white">Agent Relay</h1>
          <p className="mt-2 text-text-muted">
            {state === 'no-workspaces' ? 'Create a workspace to get started' : 'Select a workspace'}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-error/10 border border-error/20 rounded-xl">
            <p className="text-error">{error}</p>
          </div>
        )}

        {/* Workspaces list */}
        {state === 'select-workspace' && workspaces.length > 0 && (
          <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Your Workspaces</h2>
            <div className="space-y-3">
              {workspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className="flex items-center justify-between p-4 bg-bg-tertiary rounded-xl border border-border-subtle hover:border-accent-cyan/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${
                      workspace.status === 'running' ? 'bg-success' :
                      workspace.status === 'provisioning' ? 'bg-warning animate-pulse' :
                      workspace.status === 'error' ? 'bg-error' : 'bg-gray-500'
                    }`} />
                    <div>
                      <h3 className="font-medium text-white">{workspace.name}</h3>
                      <p className="text-sm text-text-muted">
                        {workspace.status === 'running' ? 'Running' :
                         workspace.status === 'provisioning' ? 'Starting...' :
                         workspace.status === 'stopped' ? 'Stopped' : 'Error'}
                      </p>
                    </div>
                  </div>
                  <div>
                    {workspace.status === 'running' && workspace.publicUrl ? (
                      <button
                        onClick={() => connectToWorkspace(workspace)}
                        className="py-2 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-lg hover:shadow-glow-cyan transition-all"
                      >
                        Connect
                      </button>
                    ) : workspace.status === 'stopped' ? (
                      <button
                        onClick={() => handleStartWorkspace(workspace)}
                        className="py-2 px-4 bg-bg-card border border-border-subtle rounded-lg text-white hover:border-accent-cyan/50 transition-colors"
                      >
                        Start
                      </button>
                    ) : workspace.status === 'provisioning' ? (
                      <span className="text-text-muted text-sm">Starting...</span>
                    ) : (
                      <span className="text-error text-sm">Failed</span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {repos.length > 0 && (
              <div className="mt-6 pt-6 border-t border-border-subtle">
                <p className="text-text-muted text-sm mb-3">Or create a new workspace:</p>
                <div className="flex gap-2 flex-wrap">
                  {repos.slice(0, 3).map((repo) => (
                    <button
                      key={repo.id}
                      onClick={() => handleCreateWorkspace(repo.fullName)}
                      className="py-2 px-3 bg-bg-card border border-border-subtle rounded-lg text-sm text-text-muted hover:text-white hover:border-accent-cyan/50 transition-colors"
                    >
                      + {repo.fullName.split('/')[1]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* No workspaces - create first one */}
        {state === 'no-workspaces' && (
          <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Create Your First Workspace</h2>
            <p className="text-text-muted mb-6">
              Select a repository to create a workspace where agents can work on your code.
            </p>

            {repos.length > 0 ? (
              <div className="space-y-3">
                {repos.map((repo) => (
                  <button
                    key={repo.id}
                    onClick={() => handleCreateWorkspace(repo.fullName)}
                    className="w-full flex items-center gap-3 p-4 bg-bg-tertiary rounded-xl border border-border-subtle hover:border-accent-cyan/50 transition-colors text-left"
                  >
                    <svg className="w-5 h-5 text-text-muted flex-shrink-0" fill="currentColor" viewBox="0 0 16 16">
                      <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium truncate">{repo.fullName}</p>
                      <p className="text-text-muted text-sm">{repo.isPrivate ? 'Private' : 'Public'}</p>
                    </div>
                    <svg className="w-5 h-5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-text-muted mb-4">No repositories connected yet.</p>
                <a
                  href="/connect-repos"
                  className="inline-flex items-center gap-2 py-3 px-6 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl hover:shadow-glow-cyan transition-all"
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                  Connect GitHub
                </a>
              </div>
            )}
          </div>
        )}

        {/* Navigation */}
        <div className="mt-6 flex justify-center gap-4 text-sm">
          <a href="/connect-repos" className="text-text-muted hover:text-white transition-colors">
            Manage Repositories
          </a>
          <span className="text-text-muted">·</span>
          <button
            onClick={async () => {
              const headers: Record<string, string> = {};
              if (csrfToken) {
                headers['X-CSRF-Token'] = csrfToken;
              }
              await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers });
              window.location.href = '/login';
            }}
            className="text-text-muted hover:text-white transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
