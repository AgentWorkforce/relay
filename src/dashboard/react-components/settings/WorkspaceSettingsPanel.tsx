/**
 * Workspace Settings Panel
 *
 * Manage workspace configuration including repositories,
 * AI providers, custom domains, and agent policies.
 *
 * Design: Mission Control theme with deep space aesthetic
 */

import React, { useState, useEffect, useCallback } from 'react';
import { cloudApi } from '../../lib/cloudApi';
import { ProviderAuthFlow } from '../ProviderAuthFlow';
import { RepoAccessPanel } from '../RepoAccessPanel';

export interface WorkspaceSettingsPanelProps {
  workspaceId: string;
  csrfToken?: string;
  onClose?: () => void;
}

interface WorkspaceDetails {
  id: string;
  name: string;
  status: string;
  publicUrl?: string;
  computeProvider: string;
  config: {
    providers: string[];
    repositories: string[];
    supervisorEnabled?: boolean;
    maxAgents?: number;
  };
  customDomain?: string;
  customDomainStatus?: string;
  errorMessage?: string;
  repositories: Array<{
    id: string;
    fullName: string;
    syncStatus: string;
    lastSyncedAt?: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface AvailableRepo {
  id: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  syncStatus: string;
  hasNangoConnection: boolean;
  lastSyncedAt?: string;
}

interface AIProvider {
  id: string;
  name: string;
  displayName: string;
  description: string;
  color: string;
  cliCommand: string;
  apiKeyUrl?: string;
  apiKeyName?: string;
  supportsOAuth?: boolean;
  supportsDeviceFlow?: boolean; // Provider supports device flow (easier for headless environments)
  preferApiKey?: boolean; // Show API key input by default (simpler for mobile/containers)
  isConnected?: boolean;
}

const AI_PROVIDERS: AIProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    displayName: 'Claude',
    description: 'Claude Code - recommended for code tasks',
    color: '#D97757',
    cliCommand: 'claude',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    apiKeyName: 'API key',
    supportsOAuth: true,
  },
  {
    id: 'codex',
    name: 'OpenAI',
    displayName: 'Codex',
    description: 'Codex - OpenAI coding assistant',
    color: '#10A37F',
    cliCommand: 'codex login',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    apiKeyName: 'API key',
    supportsOAuth: true,
    supportsDeviceFlow: true, // Codex supports --device-auth for headless environments
  },
  {
    id: 'google',
    name: 'Google',
    displayName: 'Gemini',
    description: 'Gemini - Google AI coding assistant',
    color: '#4285F4',
    cliCommand: 'gemini',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    apiKeyName: 'API key',
    supportsOAuth: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    displayName: 'OpenCode',
    description: 'OpenCode - AI coding assistant',
    color: '#00D4AA',
    cliCommand: 'opencode',
    supportsOAuth: true,
  },
  {
    id: 'droid',
    name: 'Factory',
    displayName: 'Droid',
    description: 'Droid - Factory AI coding agent',
    color: '#6366F1',
    cliCommand: 'droid',
    supportsOAuth: true,
  },
];

export function WorkspaceSettingsPanel({
  workspaceId,
  csrfToken,
  onClose,
}: WorkspaceSettingsPanelProps) {
  const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null);
  const [availableRepos, setAvailableRepos] = useState<AvailableRepo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'general' | 'providers' | 'repos' | 'github-access' | 'domain' | 'danger'>('general');

  // Provider connection state
  const [providerStatus, setProviderStatus] = useState<Record<string, boolean>>({});
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);
  const [showApiKeyFallback, setShowApiKeyFallback] = useState<Record<string, boolean>>({});
  // Device flow preference for providers that support it
  const [useDeviceFlow, setUseDeviceFlow] = useState<Record<string, boolean>>({});

  // Custom domain form
  const [customDomain, setCustomDomain] = useState('');
  const [domainLoading, setDomainLoading] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const [domainInstructions, setDomainInstructions] = useState<{
    type: string;
    name: string;
    value: string;
    ttl: number;
  } | null>(null);

  // Load workspace details
  useEffect(() => {
    async function loadWorkspace() {
      setIsLoading(true);
      setError(null);

      const [wsResult, reposResult] = await Promise.all([
        cloudApi.getWorkspaceDetails(workspaceId),
        cloudApi.getRepos(),
      ]);

      if (wsResult.success) {
        setWorkspace(wsResult.data);
        if (wsResult.data.customDomain) {
          setCustomDomain(wsResult.data.customDomain);
        }
        // Mark connected providers
        // Map backend IDs to frontend IDs for consistency
        const BACKEND_TO_FRONTEND_MAP: Record<string, string> = {
          openai: 'codex', // Backend stores 'openai', frontend uses 'codex'
        };
        const connected: Record<string, boolean> = {};
        wsResult.data.config.providers.forEach((p) => {
          connected[p] = true;
          // Also mark the frontend ID as connected if there's a mapping
          const frontendId = BACKEND_TO_FRONTEND_MAP[p];
          if (frontendId) {
            connected[frontendId] = true;
          }
        });
        setProviderStatus(connected);
      } else {
        setError(wsResult.error);
      }

      if (reposResult.success) {
        setAvailableRepos(reposResult.data.repositories);
      }

      setIsLoading(false);
    }

    loadWorkspace();
  }, [workspaceId]);

  // Start CLI-based OAuth flow for a provider
  // This just sets state to show the ProviderAuthFlow component, which handles the actual auth
  const startOAuthFlow = (provider: AIProvider) => {
    setProviderError(null);
    setConnectingProvider(provider.id);
    // ProviderAuthFlow will handle the rest when it mounts
  };

  const submitApiKey = async (provider: AIProvider) => {
    if (!apiKeyInput.trim()) {
      setProviderError('Please enter an API key');
      return;
    }

    setProviderError(null);
    setConnectingProvider(provider.id);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/onboarding/token/${provider.id}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ token: apiKeyInput.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to connect');
      }

      setProviderStatus(prev => ({ ...prev, [provider.id]: true }));
      setApiKeyInput('');
      setConnectingProvider(null);
      setShowApiKeyFallback(prev => ({ ...prev, [provider.id]: false }));
    } catch (err) {
      setProviderError(err instanceof Error ? err.message : 'Failed to connect');
      setConnectingProvider(null);
    }
  };

  // Restart workspace
  const handleRestart = useCallback(async () => {
    if (!workspace) return;

    const confirmed = window.confirm('Are you sure you want to restart this workspace?');
    if (!confirmed) return;

    const result = await cloudApi.restartWorkspace(workspace.id);
    if (result.success) {
      const wsResult = await cloudApi.getWorkspaceDetails(workspaceId);
      if (wsResult.success) {
        setWorkspace(wsResult.data);
      }
    } else {
      setError(result.error);
    }
  }, [workspace, workspaceId]);

  // Stop workspace
  const handleStop = useCallback(async () => {
    if (!workspace) return;

    const confirmed = window.confirm('Are you sure you want to stop this workspace?');
    if (!confirmed) return;

    const result = await cloudApi.stopWorkspace(workspace.id);
    if (result.success) {
      const wsResult = await cloudApi.getWorkspaceDetails(workspaceId);
      if (wsResult.success) {
        setWorkspace(wsResult.data);
      }
    } else {
      setError(result.error);
    }
  }, [workspace, workspaceId]);

  // Add repository to workspace
  const handleAddRepo = useCallback(async (repoId: string) => {
    if (!workspace) return;

    const result = await cloudApi.addReposToWorkspace(workspace.id, [repoId]);
    if (result.success) {
      const wsResult = await cloudApi.getWorkspaceDetails(workspaceId);
      if (wsResult.success) {
        setWorkspace(wsResult.data);
      }
    } else {
      setError(result.error);
    }
  }, [workspace, workspaceId]);

  // Set custom domain
  const handleSetDomain = useCallback(async () => {
    if (!workspace || !customDomain.trim()) return;

    setDomainLoading(true);
    setDomainError(null);
    setDomainInstructions(null);

    const result = await cloudApi.setCustomDomain(workspace.id, customDomain.trim());
    if (result.success) {
      setDomainInstructions(result.data.instructions);
      const wsResult = await cloudApi.getWorkspaceDetails(workspaceId);
      if (wsResult.success) {
        setWorkspace(wsResult.data);
      }
    } else {
      setDomainError(result.error);
    }

    setDomainLoading(false);
  }, [workspace, customDomain, workspaceId]);

  // Verify custom domain
  const handleVerifyDomain = useCallback(async () => {
    if (!workspace) return;

    setDomainLoading(true);
    setDomainError(null);

    const result = await cloudApi.verifyCustomDomain(workspace.id);
    if (result.success) {
      const wsResult = await cloudApi.getWorkspaceDetails(workspaceId);
      if (wsResult.success) {
        setWorkspace(wsResult.data);
      }
      if (result.data.status === 'active') {
        setDomainInstructions(null);
      }
    } else {
      setDomainError(result.error);
    }

    setDomainLoading(false);
  }, [workspace, workspaceId]);

  // Remove custom domain
  const handleRemoveDomain = useCallback(async () => {
    if (!workspace) return;

    const confirmed = window.confirm('Are you sure you want to remove the custom domain?');
    if (!confirmed) return;

    setDomainLoading(true);
    const result = await cloudApi.removeCustomDomain(workspace.id);
    if (result.success) {
      setCustomDomain('');
      setDomainInstructions(null);
      const wsResult = await cloudApi.getWorkspaceDetails(workspaceId);
      if (wsResult.success) {
        setWorkspace(wsResult.data);
      }
    } else {
      setDomainError(result.error);
    }
    setDomainLoading(false);
  }, [workspace, workspaceId]);

  // Delete workspace
  const handleDelete = useCallback(async () => {
    if (!workspace) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete "${workspace.name}"? This action cannot be undone.`
    );
    if (!confirmed) return;

    const doubleConfirm = window.confirm(
      'This will permanently delete all workspace data. Are you absolutely sure?'
    );
    if (!doubleConfirm) return;

    const result = await cloudApi.deleteWorkspace(workspace.id);
    if (result.success) {
      // Redirect to onboarding page with deleted reason
      window.location.href = '/app/onboarding?reason=deleted';
    } else {
      setError(result.error);
    }
  }, [workspace]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="relative">
          <div className="w-12 h-12 rounded-full border-2 border-accent-cyan/20 border-t-accent-cyan animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-4 h-4 rounded-full bg-accent-cyan/40 animate-pulse" />
          </div>
        </div>
        <span className="ml-4 text-text-muted font-mono text-sm tracking-wide">
          LOADING WORKSPACE CONFIG...
        </span>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <div className="p-6">
        <div className="p-4 bg-error/10 border border-error/30 rounded-lg text-error flex items-center gap-3">
          <AlertIcon />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!workspace) {
    return null;
  }

  const unassignedRepos = availableRepos.filter(
    (r) => !workspace.repositories.some((wr) => wr.id === r.id)
  );

  const sections = [
    { id: 'general', label: 'General', icon: <SettingsGearIcon /> },
    { id: 'providers', label: 'AI Providers', icon: <ProviderIcon /> },
    { id: 'repos', label: 'Repositories', icon: <RepoIcon /> },
    { id: 'github-access', label: 'GitHub Access', icon: <GitHubIcon /> },
    { id: 'domain', label: 'Domain', icon: <GlobeIcon /> },
    { id: 'danger', label: 'Danger', icon: <AlertIcon /> },
  ];

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Section Navigation */}
      <div className="flex gap-1 p-3 border-b border-border-subtle bg-gradient-to-b from-bg-tertiary to-bg-primary">
        {sections.map((section) => (
          <button
            key={section.id}
            onClick={() => setActiveSection(section.id as typeof activeSection)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              activeSection === section.id
                ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30 shadow-[0_0_12px_rgba(0,217,255,0.15)]'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary border border-transparent'
            }`}
          >
            <span className={activeSection === section.id ? 'text-accent-cyan' : 'text-text-muted'}>
              {section.icon}
            </span>
            {section.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-6 p-4 bg-error/10 border border-error/30 rounded-lg text-error text-sm flex items-center gap-3">
            <AlertIcon />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-error/60 hover:text-error">
              <CloseIcon />
            </button>
          </div>
        )}

        {/* General Section */}
        {activeSection === 'general' && (
          <div className="space-y-8">
            <SectionHeader
              title="Workspace Overview"
              subtitle="Core configuration and status"
            />

            <div className="grid grid-cols-2 gap-4">
              <InfoCard label="Name" value={workspace.name} />
              <InfoCard
                label="Status"
                value={workspace.status.charAt(0).toUpperCase() + workspace.status.slice(1)}
                valueColor={
                  workspace.status === 'running' ? 'text-success' :
                  workspace.status === 'stopped' ? 'text-amber-400' :
                  workspace.status === 'error' ? 'text-error' : 'text-text-muted'
                }
                indicator={workspace.status === 'running'}
              />
              <InfoCard
                label="Public URL"
                value={workspace.publicUrl || 'Not available'}
                mono
              />
              <InfoCard
                label="Compute Provider"
                value={workspace.computeProvider.charAt(0).toUpperCase() + workspace.computeProvider.slice(1)}
              />
            </div>

            <div>
              <SectionHeader title="Actions" subtitle="Manage workspace state" />
              <div className="flex gap-3 mt-4">
                {workspace.status === 'running' && (
                  <ActionButton
                    onClick={handleStop}
                    variant="warning"
                    icon={<StopIcon />}
                  >
                    Stop Workspace
                  </ActionButton>
                )}
                <ActionButton
                  onClick={handleRestart}
                  variant="primary"
                  icon={<RestartIcon />}
                >
                  Restart Workspace
                </ActionButton>
              </div>
            </div>
          </div>
        )}

        {/* AI Providers Section */}
        {activeSection === 'providers' && (
          <div className="space-y-8">
            <SectionHeader
              title="AI Providers"
              subtitle="Connect AI providers to spawn agents in this workspace"
            />

            {providerError && (
              <div className="p-4 bg-error/10 border border-error/30 rounded-lg text-error text-sm flex items-center gap-3">
                <AlertIcon />
                <span>{providerError}</span>
              </div>
            )}

            <div className="space-y-4">
              {AI_PROVIDERS.map((provider) => (
                <div
                  key={provider.id}
                  className="p-5 bg-bg-tertiary rounded-xl border border-border-subtle hover:border-border-medium transition-all duration-200"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div
                        className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg shadow-lg"
                        style={{
                          backgroundColor: provider.color,
                          boxShadow: `0 4px 20px ${provider.color}40`,
                        }}
                      >
                        {provider.displayName[0]}
                      </div>
                      <div>
                        <h4 className="text-base font-semibold text-text-primary">
                          {provider.displayName}
                        </h4>
                        <p className="text-sm text-text-muted">{provider.description}</p>
                      </div>
                    </div>

                    {providerStatus[provider.id] ? (
                      <div className="flex items-center gap-2 px-4 py-2 bg-success/15 rounded-full border border-success/30">
                        <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
                        <span className="text-sm font-medium text-success">Connected</span>
                      </div>
                    ) : null}
                  </div>

                  {!providerStatus[provider.id] && (
                    <div className="mt-5 pt-5 border-t border-border-subtle">
                      {connectingProvider === provider.id ? (
                        <ProviderAuthFlow
                          provider={{
                            id: provider.id,
                            name: provider.name,
                            displayName: provider.displayName,
                            color: provider.color,
                            requiresUrlCopy: provider.id === 'codex',
                          }}
                          workspaceId={workspaceId}
                          csrfToken={csrfToken}
                          useDeviceFlow={useDeviceFlow[provider.id] || false}
                          onSuccess={() => {
                            setProviderStatus(prev => ({ ...prev, [provider.id]: true }));
                            setConnectingProvider(null);
                          }}
                          onCancel={() => {
                            setConnectingProvider(null);
                          }}
                          onError={(err) => {
                            setProviderError(err);
                            setConnectingProvider(null);
                          }}
                        />
                      ) : showApiKeyFallback[provider.id] ? (
                        <div className="space-y-4">
                          <div className="flex gap-3">
                            <input
                              type="password"
                              placeholder={`Enter ${provider.displayName} ${provider.apiKeyName || 'API key'}`}
                              value={connectingProvider === provider.id ? apiKeyInput : ''}
                              onChange={(e) => {
                                setConnectingProvider(provider.id);
                                setApiKeyInput(e.target.value);
                              }}
                              onFocus={() => setConnectingProvider(provider.id)}
                              className="flex-1 px-4 py-3 bg-bg-card border border-border-subtle rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-cyan focus:ring-1 focus:ring-accent-cyan/30 transition-all"
                            />
                            <button
                              onClick={() => submitApiKey(provider)}
                              disabled={connectingProvider !== provider.id || !apiKeyInput.trim()}
                              className="px-5 py-3 bg-accent-cyan text-bg-deep font-semibold rounded-lg text-sm hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                              Connect
                            </button>
                          </div>
                          {provider.apiKeyUrl && (
                            <p className="text-xs text-text-muted">
                              Get your API key from{' '}
                              <a
                                href={provider.apiKeyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent-cyan hover:underline"
                              >
                                {new URL(provider.apiKeyUrl).hostname}
                              </a>
                            </p>
                          )}
                          {provider.supportsOAuth && (
                            <button
                              onClick={() => setShowApiKeyFallback(prev => ({ ...prev, [provider.id]: false }))}
                              className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                            >
                              ← Back to OAuth login
                            </button>
                          )}
                        </div>
                      ) : provider.supportsOAuth ? (
                        <div className="space-y-3">
                          {/* CLI info for Codex */}
                          {provider.id === 'codex' && (
                            <div className="p-3 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg">
                              <p className="text-sm text-accent-cyan font-medium mb-1">CLI-assisted authentication</p>
                              <p className="text-xs text-accent-cyan/80">
                                Codex auth uses a CLI command to capture the OAuth callback locally.
                                You&apos;ll run <code className="bg-bg-deep px-1 rounded">npx agent-relay codex-auth</code> in your terminal,
                                then sign in with OpenAI. The CLI handles the rest automatically.
                              </p>
                            </div>
                          )}
                          {/* Device flow toggle for providers that support it */}
                          {provider.supportsDeviceFlow && (
                            <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
                              <input
                                type="checkbox"
                                checked={useDeviceFlow[provider.id] || false}
                                onChange={(e) => setUseDeviceFlow(prev => ({
                                  ...prev,
                                  [provider.id]: e.target.checked,
                                }))}
                                className="w-4 h-4 rounded border-border-subtle bg-bg-card text-accent-cyan focus:ring-accent-cyan/30 cursor-pointer"
                              />
                              Use device flow (easier for containers/headless)
                            </label>
                          )}
                          <button
                            onClick={() => startOAuthFlow(provider)}
                            disabled={connectingProvider !== null}
                            className="w-full py-3 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-lg text-sm hover:shadow-glow-cyan hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none transition-all duration-200 flex items-center justify-center gap-2"
                          >
                            <LockIcon />
                            Connect with {provider.displayName}
                          </button>
                          {provider.apiKeyUrl && (
                            <button
                              onClick={() => setShowApiKeyFallback(prev => ({ ...prev, [provider.id]: true }))}
                              className="w-full text-xs text-text-muted hover:text-text-secondary transition-colors"
                            >
                              Or enter API key manually
                            </button>
                          )}
                        </div>
                      ) : (
                        /* Provider doesn't support OAuth - show API key input directly */
                        <div className="space-y-4">
                          <div className="flex gap-3">
                            <input
                              type="password"
                              placeholder={`Enter ${provider.displayName} ${provider.apiKeyName || 'API key'}`}
                              value={connectingProvider === provider.id ? apiKeyInput : ''}
                              onChange={(e) => {
                                setConnectingProvider(provider.id);
                                setApiKeyInput(e.target.value);
                              }}
                              onFocus={() => setConnectingProvider(provider.id)}
                              className="flex-1 px-4 py-3 bg-bg-card border border-border-subtle rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-cyan focus:ring-1 focus:ring-accent-cyan/30 transition-all"
                            />
                            <button
                              onClick={() => submitApiKey(provider)}
                              disabled={connectingProvider !== provider.id || !apiKeyInput.trim()}
                              className="px-5 py-3 bg-accent-cyan text-bg-deep font-semibold rounded-lg text-sm hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                            >
                              Connect
                            </button>
                          </div>
                          {provider.apiKeyUrl && (
                            <p className="text-xs text-text-muted">
                              Get your API key from{' '}
                              <a
                                href={provider.apiKeyUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-accent-cyan hover:underline"
                              >
                                {new URL(provider.apiKeyUrl).hostname}
                              </a>
                            </p>
                          )}
                          <p className="text-xs text-amber-400/80">
                            OAuth not available for {provider.displayName} in container environments
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="mt-4 pt-4 border-t border-border-subtle">
                    <p className="text-xs text-text-muted">
                      CLI: <code className="px-2 py-1 bg-bg-card rounded font-mono">{provider.cliCommand}</code>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Repositories Section */}
        {activeSection === 'repos' && (
          <div className="space-y-8">
            <SectionHeader
              title="Connected Repositories"
              subtitle="Repositories linked to this workspace"
            />

            <div className="space-y-3">
              {workspace.repositories.length > 0 ? (
                workspace.repositories.map((repo) => (
                  <div
                    key={repo.id}
                    className="flex items-center justify-between p-4 bg-bg-tertiary rounded-lg border border-border-subtle"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-bg-card flex items-center justify-center">
                        <RepoIcon />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-text-primary">{repo.fullName}</p>
                        <p className="text-xs text-text-muted">
                          {repo.lastSyncedAt
                            ? `Synced ${new Date(repo.lastSyncedAt).toLocaleDateString()}`
                            : 'Not synced'}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={repo.syncStatus} />
                  </div>
                ))
              ) : (
                <div className="p-6 bg-bg-tertiary rounded-lg border border-border-subtle border-dashed text-center">
                  <RepoIcon className="w-8 h-8 mx-auto mb-3 text-text-muted" />
                  <p className="text-sm text-text-muted">No repositories connected</p>
                </div>
              )}
            </div>

            {unassignedRepos.length > 0 && (
              <>
                <SectionHeader
                  title="Available Repositories"
                  subtitle="Add more repositories to this workspace"
                />
                <div className="space-y-3">
                  {unassignedRepos.map((repo) => (
                    <div
                      key={repo.id}
                      className="flex items-center justify-between p-4 bg-bg-tertiary rounded-lg border border-border-subtle hover:border-accent-cyan/30 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-bg-card flex items-center justify-center">
                          <RepoIcon />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-text-primary">{repo.fullName}</p>
                          <p className="text-xs text-text-muted">
                            {repo.isPrivate ? 'Private' : 'Public'}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => handleAddRepo(repo.id)}
                        className="px-4 py-2 bg-accent-cyan/10 border border-accent-cyan/30 text-accent-cyan rounded-lg text-xs font-semibold hover:bg-accent-cyan/20 transition-colors"
                      >
                        Add to Workspace
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* GitHub Access Section */}
        {activeSection === 'github-access' && (
          <div className="space-y-6">
            <SectionHeader
              title="GitHub Repository Access"
              subtitle="Repositories you have access to via your GitHub account"
            />
            <RepoAccessPanel
              workspaces={
                workspace && workspace.repositories?.length > 0
                  ? [{
                      id: workspace.id,
                      name: workspace.name,
                      repositoryFullName: workspace.repositories[0].fullName,
                      status: workspace.status as 'provisioning' | 'running' | 'stopped' | 'error',
                    }]
                  : []
              }
              onWorkspaceCreated={(workspaceId, repoFullName) => {
                // Refresh workspace data after creating
                cloudApi.getWorkspaceDetails(workspaceId).then(result => {
                  if (result.success) {
                    setWorkspace(result.data);
                  }
                });
              }}
              onOpenWorkspace={(workspaceId) => {
                // Navigate to workspace or close settings
                if (onClose) {
                  onClose();
                }
              }}
              csrfToken={csrfToken}
              className="bg-bg-tertiary rounded-xl border border-border-subtle overflow-hidden"
            />
          </div>
        )}

        {/* Custom Domain Section */}
        {activeSection === 'domain' && (
          <div className="space-y-8">
            <SectionHeader
              title="Custom Domain"
              subtitle="Connect your own domain to this workspace"
            />

            <div className="p-5 bg-gradient-to-r from-accent-purple/10 to-accent-cyan/10 border border-accent-purple/20 rounded-xl">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-accent-purple/20 flex items-center justify-center">
                  <GlobeIcon className="text-accent-purple" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-text-primary">Premium Feature</h4>
                  <p className="text-xs text-text-secondary">Requires Team or Enterprise plan</p>
                </div>
              </div>
            </div>

            {workspace.customDomain ? (
              <div className="space-y-4">
                <div className="p-5 bg-bg-tertiary rounded-xl border border-border-subtle">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-text-muted uppercase tracking-wide font-semibold">
                      Current Domain
                    </span>
                    <StatusBadge status={workspace.customDomainStatus || 'pending'} />
                  </div>
                  <p className="text-lg font-mono text-text-primary">{workspace.customDomain}</p>
                </div>

                {workspace.customDomainStatus === 'pending' && (
                  <ActionButton
                    onClick={handleVerifyDomain}
                    disabled={domainLoading}
                    variant="primary"
                    icon={<CheckIcon />}
                    fullWidth
                  >
                    {domainLoading ? 'Verifying...' : 'Verify DNS Configuration'}
                  </ActionButton>
                )}

                <ActionButton
                  onClick={handleRemoveDomain}
                  disabled={domainLoading}
                  variant="danger"
                  icon={<TrashIcon />}
                  fullWidth
                >
                  Remove Custom Domain
                </ActionButton>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2 block">
                    Domain Name
                  </label>
                  <input
                    type="text"
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="workspace.yourdomain.com"
                    className="w-full px-4 py-3 bg-bg-tertiary border border-border-subtle rounded-lg text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-accent-cyan focus:ring-1 focus:ring-accent-cyan/30 transition-all"
                  />
                </div>

                <ActionButton
                  onClick={handleSetDomain}
                  disabled={domainLoading || !customDomain.trim()}
                  variant="primary"
                  icon={<GlobeIcon />}
                  fullWidth
                >
                  {domainLoading ? 'Setting up...' : 'Set Custom Domain'}
                </ActionButton>
              </div>
            )}

            {domainError && (
              <div className="p-4 bg-error/10 border border-error/30 rounded-lg text-error text-sm">
                {domainError}
              </div>
            )}

            {domainInstructions && (
              <div className="p-5 bg-bg-tertiary rounded-xl border border-border-subtle space-y-4">
                <h4 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <InfoIcon />
                  DNS Configuration Required
                </h4>
                <p className="text-xs text-text-secondary">
                  Add the following DNS record to your domain provider:
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <DNSField label="Type" value={domainInstructions.type} />
                  <DNSField label="Name" value={domainInstructions.name} />
                  <DNSField label="Value" value={domainInstructions.value} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Danger Zone Section */}
        {activeSection === 'danger' && (
          <div className="space-y-8">
            <div className="p-6 bg-error/5 border-2 border-error/20 rounded-xl">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-error/20 flex items-center justify-center">
                  <AlertIcon className="text-error" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-error">Danger Zone</h3>
                  <p className="text-xs text-text-secondary">
                    These actions are destructive and cannot be undone
                  </p>
                </div>
              </div>

              <div className="p-5 border border-error/30 rounded-lg bg-bg-primary">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-text-primary">Delete Workspace</h4>
                    <p className="text-xs text-text-muted mt-1">
                      Permanently delete this workspace and all its data
                    </p>
                  </div>
                  <button
                    onClick={handleDelete}
                    className="px-5 py-2.5 bg-error text-white rounded-lg text-sm font-semibold hover:bg-error/90 transition-colors"
                  >
                    Delete Workspace
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Utility Components
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide">{title}</h3>
      <p className="text-xs text-text-muted mt-1">{subtitle}</p>
    </div>
  );
}

function InfoCard({
  label,
  value,
  valueColor = 'text-text-primary',
  mono = false,
  indicator = false,
}: {
  label: string;
  value: string;
  valueColor?: string;
  mono?: boolean;
  indicator?: boolean;
}) {
  return (
    <div className="p-4 bg-bg-tertiary rounded-lg border border-border-subtle">
      <label className="text-xs text-text-muted uppercase tracking-wide font-medium">{label}</label>
      <div className="flex items-center gap-2 mt-1">
        {indicator && <div className="w-2 h-2 rounded-full bg-success animate-pulse" />}
        <p className={`text-sm font-medium ${valueColor} ${mono ? 'font-mono' : ''} break-all`}>
          {value}
        </p>
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  variant,
  icon,
  fullWidth,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant: 'primary' | 'warning' | 'danger';
  icon?: React.ReactNode;
  fullWidth?: boolean;
}) {
  const variants = {
    primary: 'bg-accent-cyan/10 border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/20',
    warning: 'bg-amber-400/10 border-amber-400/30 text-amber-400 hover:bg-amber-400/20',
    danger: 'bg-error/10 border-error/30 text-error hover:bg-error/20',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${fullWidth ? 'w-full' : ''} px-5 py-2.5 border rounded-lg text-sm font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${variants[variant]}`}
    >
      {icon}
      {children}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    synced: 'bg-success/15 text-success border-success/30',
    active: 'bg-success/15 text-success border-success/30',
    syncing: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30',
    verifying: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30',
    pending: 'bg-amber-400/15 text-amber-400 border-amber-400/30',
    error: 'bg-error/15 text-error border-error/30',
  };

  return (
    <span className={`text-xs px-3 py-1 rounded-full border ${styles[status] || 'bg-bg-hover text-text-muted border-border-subtle'}`}>
      {status}
    </span>
  );
}

function DNSField({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 bg-bg-card rounded-lg">
      <label className="text-xs text-text-muted block mb-1">{label}</label>
      <p className="font-mono text-sm text-text-primary break-all">{value}</p>
    </div>
  );
}

// Icons
function SettingsGearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function ProviderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function RepoIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-text-muted ${className}`}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function GlobeIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function AlertIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="6" width="12" height="12" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
