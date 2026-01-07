/**
 * Providers Page
 *
 * Connect AI providers (Anthropic, OpenAI, etc.) to enable workspace creation.
 * Uses the same auth flows as the main app:
 * - Claude: Terminal-based interactive setup (xterm)
 * - Codex: OAuth flow with SSH tunnel (ProviderAuthFlow)
 */

'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { LogoIcon } from '../../react-components/Logo';
import { TerminalProviderSetup } from '../../react-components/TerminalProviderSetup';
import { ProviderAuthFlow } from '../../react-components/ProviderAuthFlow';

interface Provider {
  id: string;
  name: string;
  displayName: string;
  description: string;
  color: string;
  isConnected: boolean;
  connectedAs?: string;
  /** CLI command for this provider (e.g., 'claude', 'codex') */
  cliCommand?: string;
}

// Map provider IDs to their auth method and CLI config
const PROVIDER_AUTH_CONFIG: Record<string, {
  cliCommand: string;
  /** 'terminal' for xterm-based, 'oauth' for ProviderAuthFlow */
  authMethod: 'terminal' | 'oauth';
  /** For OAuth providers, whether they need URL copy (localhost callback) */
  requiresUrlCopy?: boolean;
  /** For OAuth providers, whether they support device flow */
  supportsDeviceFlow?: boolean;
}> = {
  anthropic: { cliCommand: 'claude', authMethod: 'terminal' },
  openai: { cliCommand: 'codex', authMethod: 'oauth', requiresUrlCopy: true, supportsDeviceFlow: true },
  google: { cliCommand: 'gemini', authMethod: 'oauth' },
};

// Loading fallback for Suspense
function ProvidersLoading() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
      <div className="text-center">
        <svg className="w-8 h-8 text-accent-cyan animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="mt-4 text-text-muted">Loading providers...</p>
      </div>
    </div>
  );
}

// Main content component that uses useSearchParams
function ProvidersContent() {
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get('workspace');

  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [connectionMode, setConnectionMode] = useState<'select' | 'api-key' | 'terminal' | 'oauth'>('select');
  const [apiKey, setApiKey] = useState('');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const res = await fetch('/api/providers', { credentials: 'include' });

        // Capture CSRF token
        const token = res.headers.get('X-CSRF-Token');
        if (token) setCsrfToken(token);

        if (!res.ok) {
          if (res.status === 401) {
            window.location.href = '/login';
            return;
          }
          throw new Error('Failed to fetch providers');
        }

        const data = await res.json();
        setProviders(data.providers || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load providers');
      } finally {
        setLoading(false);
      }
    };

    fetchProviders();
  }, []);

  const handleConnect = async (providerId: string) => {
    if (!apiKey.trim()) {
      setError('Please enter an API key');
      return;
    }

    setError(null);
    setConnectingProvider(providerId);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/providers/${providerId}/api-key`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to connect provider');
      }

      // Update provider state
      setProviders(prev =>
        prev.map(p => (p.id === providerId ? { ...p, isConnected: true } : p))
      );
      setApiKey('');
      setConnectingProvider(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setConnectingProvider(null);
    }
  };

  const hasConnectedProvider = providers.some(p => p.isConnected && p.id !== 'github');

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <svg className="w-8 h-8 text-accent-cyan animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="mt-4 text-text-muted">Loading providers...</p>
        </div>
      </div>
    );
  }

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
          <h1 className="mt-4 text-2xl font-bold text-white">Connect AI Providers</h1>
          <p className="mt-2 text-text-muted text-center">
            Connect your AI providers via CLI authentication or API keys.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-error/10 border border-error/20 rounded-xl">
            <p className="text-error">{error}</p>
          </div>
        )}

        {/* Providers list */}
        <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6 space-y-4">
          {providers
            .filter(p => p.id !== 'github') // Don't show GitHub here
            .map(provider => {
              const authConfig = PROVIDER_AUTH_CONFIG[provider.id];
              const isActiveProvider = connectingProvider === provider.id;

              return (
                <div
                  key={provider.id}
                  className="p-4 bg-bg-tertiary rounded-xl border border-border-subtle"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                        style={{ backgroundColor: provider.color }}
                      >
                        {provider.displayName[0]}
                      </div>
                      <div>
                        <h3 className="font-medium text-white">{provider.displayName}</h3>
                        <p className="text-sm text-text-muted">{provider.description}</p>
                      </div>
                    </div>
                    {provider.isConnected && (
                      <span className="px-3 py-1 bg-success/20 text-success text-sm rounded-full">
                        Connected
                      </span>
                    )}
                  </div>

                  {!provider.isConnected && (
                    <>
                      {/* Show connect button when not active or in select mode */}
                      {(!isActiveProvider || connectionMode === 'select') && (
                        <div className="flex gap-2">
                          {/* Primary: CLI-based connection (requires workspace) */}
                          {authConfig && workspaceId && (
                            <button
                              onClick={() => {
                                // Claude uses terminal-based xterm setup
                                if (authConfig.authMethod === 'terminal') {
                                  window.location.href = `/providers/setup/${authConfig.cliCommand}?workspace=${workspaceId}`;
                                  return;
                                }
                                // Codex/others use OAuth flow
                                setConnectingProvider(provider.id);
                                setConnectionMode('oauth');
                                setError(null);
                              }}
                              className="flex-1 px-4 py-2 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-lg hover:shadow-glow-cyan transition-all"
                            >
                              {authConfig.authMethod === 'terminal' ? 'Connect via CLI' : `Connect with ${provider.displayName}`}
                            </button>
                          )}
                          {/* Fallback: API key connection */}
                          <button
                            onClick={() => {
                              setConnectingProvider(provider.id);
                              setConnectionMode('api-key');
                              setError(null);
                            }}
                            className={`px-4 py-2 rounded-lg font-medium transition-all ${
                              authConfig && workspaceId
                                ? 'bg-bg-hover text-text-secondary hover:text-white border border-border-subtle'
                                : 'flex-1 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold hover:shadow-glow-cyan'
                            }`}
                          >
                            {authConfig && workspaceId ? 'Use API Key' : 'Connect'}
                          </button>
                        </div>
                      )}

                      {/* API Key input mode */}
                      {isActiveProvider && connectionMode === 'api-key' && (
                        <div className="space-y-3">
                          <div className="flex gap-2">
                            <input
                              type="password"
                              placeholder={`Enter ${provider.displayName} API key`}
                              value={apiKey}
                              onChange={e => setApiKey(e.target.value)}
                              autoFocus
                              className="flex-1 px-4 py-2 bg-bg-deep border border-border-subtle rounded-lg text-white placeholder-text-muted focus:outline-none focus:border-accent-cyan/50"
                            />
                            <button
                              onClick={() => handleConnect(provider.id)}
                              disabled={!apiKey.trim()}
                              className="px-4 py-2 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-lg hover:shadow-glow-cyan transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Connect
                            </button>
                          </div>
                          <button
                            onClick={() => {
                              setConnectionMode('select');
                              setApiKey('');
                            }}
                            className="text-sm text-text-muted hover:text-white transition-colors"
                          >
                            ← Back to options
                          </button>
                        </div>
                      )}

                      {/* OAuth flow mode (for Codex, etc.) */}
                      {isActiveProvider && connectionMode === 'oauth' && workspaceId && authConfig && (
                        <div className="mt-3">
                          <ProviderAuthFlow
                            provider={{
                              id: provider.id,
                              name: authConfig.cliCommand,
                              displayName: provider.displayName,
                              color: provider.color,
                              requiresUrlCopy: authConfig.requiresUrlCopy,
                              supportsDeviceFlow: authConfig.supportsDeviceFlow,
                            }}
                            workspaceId={workspaceId}
                            csrfToken={csrfToken || undefined}
                            onSuccess={() => {
                              setProviders(prev =>
                                prev.map(p => (p.id === provider.id ? { ...p, isConnected: true } : p))
                              );
                              setConnectingProvider(null);
                              setConnectionMode('select');
                            }}
                            onCancel={() => {
                              setConnectingProvider(null);
                              setConnectionMode('select');
                            }}
                            onError={(err) => {
                              setError(err);
                              setConnectingProvider(null);
                              setConnectionMode('select');
                            }}
                          />
                          <button
                            onClick={() => {
                              setConnectionMode('select');
                            }}
                            className="mt-2 text-sm text-text-muted hover:text-white transition-colors"
                          >
                            ← Back to options
                          </button>
                        </div>
                      )}

                      {/* Terminal setup mode (legacy - now redirects to /providers/setup) */}
                      {isActiveProvider && connectionMode === 'terminal' && workspaceId && authConfig && (
                        <div className="mt-3">
                          <TerminalProviderSetup
                            provider={{
                              id: authConfig.cliCommand,
                              name: provider.id,
                              displayName: provider.displayName,
                              color: provider.color,
                            }}
                            workspaceId={workspaceId}
                            csrfToken={csrfToken || undefined}
                            maxHeight="350px"
                            showHeader={false}
                            onSuccess={() => {
                              setProviders(prev =>
                                prev.map(p => (p.id === provider.id ? { ...p, isConnected: true } : p))
                              );
                              setConnectingProvider(null);
                              setConnectionMode('select');
                            }}
                            onCancel={() => {
                              setConnectingProvider(null);
                              setConnectionMode('select');
                            }}
                            onConnectAnother={() => {
                              setProviders(prev =>
                                prev.map(p => (p.id === provider.id ? { ...p, isConnected: true } : p))
                              );
                              setConnectingProvider(null);
                              setConnectionMode('select');
                            }}
                            onError={(err) => {
                              setError(err);
                              setConnectingProvider(null);
                              setConnectionMode('select');
                            }}
                          />
                          <button
                            onClick={() => {
                              setConnectionMode('select');
                            }}
                            className="mt-2 text-sm text-text-muted hover:text-white transition-colors"
                          >
                            ← Back to options
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
        </div>

        {/* No workspace warning */}
        {!workspaceId && (
          <div className="mt-4 p-4 bg-warning/10 border border-warning/20 rounded-xl">
            <p className="text-warning text-sm">
              <strong>Note:</strong> CLI-based authentication requires a running workspace.
              You can still connect using API keys, or{' '}
              <a href="/app" className="underline hover:no-underline">create a workspace</a> first.
            </p>
          </div>
        )}

        {/* Continue button */}
        <div className="mt-6 flex flex-col items-center gap-4">
          {hasConnectedProvider ? (
            <a
              href={workspaceId ? `/app?workspace=${workspaceId}` : '/app'}
              className="w-full py-3 px-6 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl text-center hover:shadow-glow-cyan transition-all"
            >
              Continue to Dashboard
            </a>
          ) : (
            <p className="text-text-muted text-sm">
              Connect at least one AI provider to continue
            </p>
          )}

          <a
            href={workspaceId ? `/app?workspace=${workspaceId}` : '/app'}
            className="text-text-muted hover:text-white transition-colors text-sm"
          >
            Skip for now
          </a>
        </div>
      </div>
    </div>
  );
}

// Export page wrapped in Suspense for static generation
export default function ProvidersPage() {
  return (
    <Suspense fallback={<ProvidersLoading />}>
      <ProvidersContent />
    </Suspense>
  );
}
