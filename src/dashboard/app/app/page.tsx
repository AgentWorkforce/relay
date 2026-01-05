/**
 * Dashboard V2 - Main App Page
 *
 * In cloud mode: Shows workspace selection and connects to selected workspace's dashboard.
 * In local mode: Connects to local daemon WebSocket.
 */

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { App } from '../../react-components/App';
import { CloudSessionProvider } from '../../react-components/CloudSessionProvider';
import { LogoIcon } from '../../react-components/Logo';
import { setActiveWorkspaceId } from '../../lib/api';
import { ProviderAuthFlow } from '../../react-components/ProviderAuthFlow';
import { ProvisioningProgress } from '../../react-components/ProvisioningProgress';

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
  /** Whether this provider supports device flow (code displayed on screen) */
  supportsDeviceFlow?: boolean;
  /** Whether standard flow redirects to a URL the user must copy (shows "not found" page) */
  requiresUrlCopy?: boolean;
}

// ProviderAuthState simplified - now using ProviderAuthFlow shared component

type PageState = 'loading' | 'local' | 'select-workspace' | 'no-workspaces' | 'provisioning' | 'connect-provider' | 'connecting' | 'connected' | 'error';

interface ProvisioningInfo {
  workspaceId: string;
  workspaceName: string;
  stage: string | null;
  startedAt: number;
}

// Available AI providers
const AI_PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic', displayName: 'Claude', color: '#D97757', cliCommand: 'claude' },
  { id: 'codex', name: 'OpenAI', displayName: 'Codex', color: '#10A37F', cliCommand: 'codex login', supportsDeviceFlow: true, requiresUrlCopy: true },
  { id: 'opencode', name: 'OpenCode', displayName: 'OpenCode', color: '#00D4AA', cliCommand: 'opencode' },
  { id: 'droid', name: 'Factory', displayName: 'Droid', color: '#6366F1', cliCommand: 'droid' },
];

// Force cloud mode via env var - prevents silent fallback to local mode
const FORCE_CLOUD_MODE = process.env.NEXT_PUBLIC_FORCE_CLOUD_MODE === 'true';

export default function DashboardPage() {
  const [state, setState] = useState<PageState>('loading');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null);
  const [wsUrl, setWsUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Track cloud mode for potential future use
  const [_isCloudMode, setIsCloudMode] = useState(FORCE_CLOUD_MODE);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [provisioningInfo, setProvisioningInfo] = useState<ProvisioningInfo | null>(null);
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);

  // Check if we're in cloud mode and fetch data
  useEffect(() => {
    const init = async () => {
      try {
        // Check session to determine if we're in cloud mode
        const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });

        // If session endpoint doesn't exist (404), we're in local mode
        if (sessionRes.status === 404) {
          if (FORCE_CLOUD_MODE) {
            throw new Error('Cloud mode enforced but session endpoint returned 404. Is the cloud server running?');
          }
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

        // Track which providers are already connected
        if (session.connectedProviders) {
          setConnectedProviders(session.connectedProviders.map((p: { provider: string }) => p.provider));
        }

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
        // If session check fails with network error, assume local mode (unless forced cloud)
        if (err instanceof TypeError && err.message.includes('Failed to fetch')) {
          if (FORCE_CLOUD_MODE) {
            console.error('Cloud mode enforced but network request failed:', err);
            setError('Cloud mode enforced but failed to connect to server. Is the cloud server running?');
            setState('error');
            return;
          }
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

      // Set provisioning state with workspace info
      const startedAt = Date.now();
      setProvisioningInfo({
        workspaceId: data.workspaceId,
        workspaceName: repoFullName.split('/')[1] || repoFullName,
        stage: null,
        startedAt,
      });
      setState('provisioning');

      // Poll for workspace to be ready
      // Cloud deployments (Fly.io) can take 3-5 minutes for cold starts
      const pollForReady = async (workspaceId: string) => {
        const maxAttempts = 150; // 5 minutes with 2s interval
        const pollIntervalMs = 2000;
        let attempts = 0;

        while (attempts < maxAttempts) {
          const statusRes = await fetch(`/api/workspaces/${workspaceId}/status`, {
            credentials: 'include',
          });
          const statusData = await statusRes.json();

          // Update provisioning stage if available
          if (statusData.provisioning?.stage) {
            setProvisioningInfo(prev => prev ? {
              ...prev,
              stage: statusData.provisioning.stage,
            } : null);
          }

          if (statusData.status === 'running') {
            // Fetch updated workspace info
            const wsRes = await fetch(`/api/workspaces/${workspaceId}`, {
              credentials: 'include',
            });
            const wsData = await wsRes.json();
            if (wsData.publicUrl) {
              // Clear provisioning info and show provider connection screen
              setProvisioningInfo(null);
              setSelectedWorkspace(wsData);
              setState('connect-provider');
              return;
            }
          } else if (statusData.status === 'error') {
            const errorMsg = statusData.errorMessage || 'Workspace provisioning failed';
            throw new Error(errorMsg);
          }

          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          attempts++;

          // Log progress every 30 seconds
          if (attempts % 15 === 0) {
            console.log(`[workspace] Still provisioning... (${Math.floor(attempts * pollIntervalMs / 1000)}s elapsed)`);
          }
        }

        throw new Error('Workspace provisioning timed out after 5 minutes. Please try again or contact support.');
      };

      await pollForReady(data.workspaceId);
    } catch (err) {
      console.error('Create workspace error:', err);
      setProvisioningInfo(null);
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setState('no-workspaces');
    }
  }, [connectToWorkspace, csrfToken]);

  // Handle connecting an AI provider - simplified with ProviderAuthFlow component
  const handleConnectProvider = useCallback((provider: ProviderInfo) => {
    if (!selectedWorkspace) return;
    setConnectingProvider(provider.id);
  }, [selectedWorkspace]);

  // Skip provider connection and continue to workspace
  const handleSkipProvider = useCallback(() => {
    if (selectedWorkspace) {
      setConnectingProvider(null);
      connectToWorkspace(selectedWorkspace);
    }
  }, [selectedWorkspace, connectToWorkspace]);

  // Connect another provider after successful auth
  const handleConnectAnother = useCallback(() => {
    setConnectingProvider(null);
    // Stay on connect-provider screen
  }, []);

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
  // Wrap in CloudSessionProvider so App has access to cloud session context
  if (state === 'connected' && wsUrl) {
    return (
      <CloudSessionProvider cloudMode={true}>
        <App wsUrl={wsUrl} />
      </CloudSessionProvider>
    );
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

  // Provisioning state - show progress UI
  if (state === 'provisioning' && provisioningInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
        <div className="w-full max-w-xl">
          <ProvisioningProgress
            isProvisioning={true}
            currentStage={provisioningInfo.stage}
            workspaceName={provisioningInfo.workspaceName}
            error={error}
            onCancel={() => {
              setProvisioningInfo(null);
              setState('no-workspaces');
            }}
          />
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

          {/* Provider auth flow - using shared component */}
          {connectingProvider && (() => {
            const provider = AI_PROVIDERS.find(p => p.id === connectingProvider);
            if (!provider) return null;
            return (
              <div className="mb-6 bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6">
                <ProviderAuthFlow
                  provider={{
                    id: provider.id,
                    name: provider.name,
                    displayName: provider.displayName,
                    color: provider.color,
                    requiresUrlCopy: provider.requiresUrlCopy,
                    supportsDeviceFlow: provider.supportsDeviceFlow,
                  }}
                  workspaceId={selectedWorkspace!.id}
                  csrfToken={csrfToken || undefined}
                  onSuccess={() => {
                    // Add provider to connected list
                    setConnectedProviders(prev => [...new Set([...prev, provider.id])]);
                    // Show success state briefly, then offer options
                    setConnectingProvider(null);
                    // Stay on connect-provider screen to allow connecting more providers
                    // User can click "Continue to Dashboard" or connect another
                  }}
                  onCancel={() => {
                    setConnectingProvider(null);
                  }}
                  onError={() => {
                    setConnectingProvider(null);
                  }}
                />

                {/* After success, show options to connect another or continue */}
                <div className="mt-4 pt-4 border-t border-border-subtle space-y-3">
                  <button
                    onClick={handleConnectAnother}
                    className="w-full py-3 px-4 bg-bg-tertiary border border-border-subtle text-white rounded-xl text-center hover:border-accent-cyan/50 transition-colors"
                  >
                    Connect Another Provider
                  </button>
                  <button
                    onClick={handleSkipProvider}
                    className="w-full py-3 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl text-center hover:shadow-glow-cyan transition-all"
                  >
                    Continue to Dashboard
                  </button>
                </div>
              </div>
            );
          })()}

          {/* Provider list */}
          {!connectingProvider && (
            <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Choose an AI Provider</h2>
              <div className="space-y-3">
                {AI_PROVIDERS.map((provider) => (
                  <div key={provider.id}>
                    {/* Special expanded section for Codex with CLI auth flow */}
                    {provider.id === 'codex' ? (
                      <div className={`p-4 bg-bg-tertiary rounded-xl border space-y-4 ${connectedProviders.includes(provider.id) || connectedProviders.includes('openai') ? 'border-green-500/50' : 'border-border-subtle'}`}>
                        <div className="flex items-center gap-3">
                          <div
                            className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold flex-shrink-0 relative"
                            style={{ backgroundColor: provider.color }}
                          >
                            {provider.displayName[0]}
                            {(connectedProviders.includes(provider.id) || connectedProviders.includes('openai')) && (
                              <div className="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                            )}
                          </div>
                          <div className="flex-1">
                            <p className="text-white font-medium">{provider.displayName}</p>
                            <p className="text-text-muted text-sm">{provider.name}</p>
                          </div>
                          {(connectedProviders.includes(provider.id) || connectedProviders.includes('openai')) && (
                            <span className="text-green-400 text-sm font-medium">Connected</span>
                          )}
                        </div>

                        {!(connectedProviders.includes(provider.id) || connectedProviders.includes('openai')) && (
                          <>
                            {/* Info about CLI auth flow */}
                            <div className="p-3 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg">
                              <p className="text-sm text-accent-cyan font-medium mb-1">CLI-assisted authentication</p>
                              <p className="text-xs text-accent-cyan/80">
                                Codex auth uses a simple CLI command to capture the OAuth callback locally.
                                You&apos;ll run <code className="bg-bg-deep px-1 rounded">npx agent-relay codex-auth</code> in your terminal,
                                then sign in with OpenAI. The CLI handles the rest automatically.
                              </p>
                            </div>

                            {/* Single connect button */}
                            <button
                              onClick={() => handleConnectProvider(provider)}
                              className="w-full flex items-center justify-center gap-2 p-3 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl hover:shadow-glow-cyan transition-all"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              </svg>
                              Connect with Codex
                            </button>
                          </>
                        )}
                      </div>
                    ) : (
                      /* Standard provider button */
                      <button
                        onClick={() => handleConnectProvider(provider)}
                        className={`w-full flex items-center gap-3 p-4 bg-bg-tertiary rounded-xl border transition-colors text-left ${connectedProviders.includes(provider.id) ? 'border-green-500/50' : 'border-border-subtle hover:border-accent-cyan/50'}`}
                      >
                        <div
                          className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold flex-shrink-0 relative"
                          style={{ backgroundColor: provider.color }}
                        >
                          {provider.displayName[0]}
                          {connectedProviders.includes(provider.id) && (
                            <div className="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                              <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                          )}
                        </div>
                        <div className="flex-1">
                          <p className="text-white font-medium">{provider.displayName}</p>
                          <p className="text-text-muted text-sm">{provider.name}</p>
                        </div>
                        {connectedProviders.includes(provider.id) ? (
                          <span className="text-green-400 text-sm font-medium">Connected</span>
                        ) : (
                          <svg className="w-5 h-5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
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
