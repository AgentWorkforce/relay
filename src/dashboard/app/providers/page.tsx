/**
 * Providers Page
 *
 * Connect AI providers (Anthropic, OpenAI, etc.) to enable workspace creation.
 */

'use client';

import React, { useState, useEffect } from 'react';
import { LogoIcon } from '../../react-components/Logo';

interface Provider {
  id: string;
  name: string;
  displayName: string;
  description: string;
  color: string;
  isConnected: boolean;
  connectedAs?: string;
}

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
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
            Add your API keys to enable AI-powered coding assistants in your workspace.
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
            .map(provider => (
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
                  <div className="flex gap-2">
                    <input
                      type="password"
                      placeholder={`Enter ${provider.displayName} API key`}
                      value={connectingProvider === provider.id ? apiKey : ''}
                      onChange={e => {
                        setConnectingProvider(provider.id);
                        setApiKey(e.target.value);
                      }}
                      onFocus={() => setConnectingProvider(provider.id)}
                      className="flex-1 px-4 py-2 bg-bg-deep border border-border-subtle rounded-lg text-white placeholder-text-muted focus:outline-none focus:border-accent-cyan/50"
                    />
                    <button
                      onClick={() => handleConnect(provider.id)}
                      disabled={connectingProvider === provider.id && !apiKey.trim()}
                      className="px-4 py-2 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-lg hover:shadow-glow-cyan transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {connectingProvider === provider.id ? 'Connecting...' : 'Connect'}
                    </button>
                  </div>
                )}
              </div>
            ))}
        </div>

        {/* Continue button */}
        <div className="mt-6 flex flex-col items-center gap-4">
          {hasConnectedProvider ? (
            <a
              href="/app"
              className="w-full py-3 px-6 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl text-center hover:shadow-glow-cyan transition-all"
            >
              Continue to Dashboard
            </a>
          ) : (
            <p className="text-text-muted text-sm">
              Connect at least one AI provider to continue
            </p>
          )}

          <a href="/app" className="text-text-muted hover:text-white transition-colors text-sm">
            Skip for now
          </a>
        </div>
      </div>
    </div>
  );
}
