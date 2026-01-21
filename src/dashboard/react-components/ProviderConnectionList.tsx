/**
 * ProviderConnectionList - Shared component for AI provider connection UI
 *
 * Used by both /app (onboarding) and /providers pages to ensure consistent UX.
 * Handles Claude (terminal), Codex (CLI-assisted), and other providers.
 */

import React, { useState } from 'react';
import { TerminalProviderSetup } from './TerminalProviderSetup';
import { ProviderAuthFlow } from './ProviderAuthFlow';

export interface ProviderInfo {
  id: string;
  name: string;
  displayName: string;
  color: string;
  cliCommand?: string;
  isConnected?: boolean;
  description?: string;
  /** For OAuth providers, whether they need URL copy (localhost callback) */
  requiresUrlCopy?: boolean;
  /** For OAuth providers, whether they support device flow */
  supportsDeviceFlow?: boolean;
}

// Provider auth configuration
const PROVIDER_AUTH_CONFIG: Record<string, {
  authMethod: 'terminal' | 'oauth';
  requiresUrlCopy?: boolean;
  supportsDeviceFlow?: boolean;
}> = {
  anthropic: { authMethod: 'terminal' },
  codex: { authMethod: 'oauth', requiresUrlCopy: true, supportsDeviceFlow: true },
  openai: { authMethod: 'oauth', requiresUrlCopy: true, supportsDeviceFlow: true },
  // Gemini uses terminal - CLI shows interactive menu for OAuth vs API key
  google: { authMethod: 'terminal' },
  opencode: { authMethod: 'terminal' },
  droid: { authMethod: 'terminal' },
  cursor: { authMethod: 'terminal' },
};

export interface ProviderConnectionListProps {
  providers: ProviderInfo[];
  connectedProviders: string[];
  workspaceId: string;
  csrfToken?: string;
  onProviderConnected: (providerId: string) => void;
  onConnectAnother?: () => void;
  onContinue?: () => void;
  /** Show expanded info sections for Claude/Codex */
  showDetailedInfo?: boolean;
}

export function ProviderConnectionList({
  providers,
  connectedProviders,
  workspaceId,
  csrfToken,
  onProviderConnected,
  onConnectAnother,
  onContinue,
  showDetailedInfo = true,
}: ProviderConnectionListProps) {
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);
  const [connectionMode, setConnectionMode] = useState<'select' | 'terminal' | 'oauth'>('select');
  const [error, setError] = useState<string | null>(null);

  const handleConnectProvider = (provider: ProviderInfo) => {
    const authConfig = PROVIDER_AUTH_CONFIG[provider.id];

    if (authConfig?.authMethod === 'terminal') {
      // Terminal-based setup (Claude, Cursor, etc.)
      setConnectingProvider(provider.id);
      setConnectionMode('terminal');
    } else if (authConfig?.authMethod === 'oauth') {
      // OAuth-based setup (Codex, etc.)
      setConnectingProvider(provider.id);
      setConnectionMode('oauth');
    } else {
      // Default to terminal
      setConnectingProvider(provider.id);
      setConnectionMode('terminal');
    }
    setError(null);
  };

  const handleSuccess = (providerId: string) => {
    onProviderConnected(providerId);
    setConnectingProvider(null);
    setConnectionMode('select');
  };

  const handleCancel = () => {
    setConnectingProvider(null);
    setConnectionMode('select');
  };

  const handleError = (err: string) => {
    setError(err);
    setConnectingProvider(null);
    setConnectionMode('select');
  };

  const isProviderConnected = (providerId: string) => {
    // Handle openai/codex mapping
    if (providerId === 'codex') {
      return connectedProviders.includes('codex') || connectedProviders.includes('openai');
    }
    return connectedProviders.includes(providerId);
  };

  // If actively connecting, show the connection flow
  if (connectingProvider && connectionMode !== 'select') {
    const provider = providers.find(p => p.id === connectingProvider);
    if (!provider) return null;

    const authConfig = PROVIDER_AUTH_CONFIG[provider.id];

    return (
      <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
            style={{ backgroundColor: provider.color }}
          >
            {provider.displayName[0]}
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">{provider.displayName} Setup</h3>
            <p className="text-sm text-text-muted">
              {connectionMode === 'terminal' ? 'Interactive terminal' : 'OAuth authentication'}
            </p>
          </div>
          <button
            onClick={handleCancel}
            className="ml-auto p-2 text-text-muted hover:text-white transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg">
            <p className="text-error text-sm">{error}</p>
          </div>
        )}

        {/* Terminal setup */}
        {connectionMode === 'terminal' && (
          <TerminalProviderSetup
            provider={{
              id: provider.cliCommand || provider.id,
              name: provider.id,
              displayName: provider.displayName,
              color: provider.color,
            }}
            workspaceId={workspaceId}
            csrfToken={csrfToken}
            maxHeight="400px"
            showHeader={false}
            onSuccess={() => handleSuccess(provider.id)}
            onCancel={handleCancel}
            onConnectAnother={() => {
              handleSuccess(provider.id);
              onConnectAnother?.();
            }}
            onError={handleError}
          />
        )}

        {/* OAuth setup */}
        {connectionMode === 'oauth' && authConfig && (
          <ProviderAuthFlow
            provider={{
              id: provider.id,
              name: provider.cliCommand || provider.id,
              displayName: provider.displayName,
              color: provider.color,
              requiresUrlCopy: authConfig.requiresUrlCopy,
              supportsDeviceFlow: authConfig.supportsDeviceFlow,
            }}
            workspaceId={workspaceId}
            csrfToken={csrfToken}
            onSuccess={() => handleSuccess(provider.id)}
            onCancel={handleCancel}
            onError={handleError}
          />
        )}

        {/* Back button */}
        <button
          onClick={handleCancel}
          className="mt-4 text-sm text-text-muted hover:text-white transition-colors"
        >
          &larr; Back to provider list
        </button>
      </div>
    );
  }

  // Show provider list
  return (
    <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6">
      <h2 className="text-lg font-semibold text-white mb-4">Choose an AI Provider</h2>

      {error && (
        <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-error text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-3">
        {providers.map((provider) => {
          const connected = isProviderConnected(provider.id);
          const authConfig = PROVIDER_AUTH_CONFIG[provider.id];
          const isTerminal = authConfig?.authMethod === 'terminal';
          const isOAuth = authConfig?.authMethod === 'oauth';

          // Expanded card for Claude/Codex when showDetailedInfo is true
          if (showDetailedInfo && (provider.id === 'anthropic' || provider.id === 'codex')) {
            return (
              <div
                key={provider.id}
                className={`p-4 bg-bg-tertiary rounded-xl border space-y-4 ${
                  connected ? 'border-green-500/50' : 'border-border-subtle'
                }`}
              >
                {/* Provider header */}
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold flex-shrink-0 relative"
                    style={{ backgroundColor: provider.color }}
                  >
                    {provider.displayName[0]}
                    {connected && (
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
                  {connected && (
                    <span className="text-green-400 text-sm font-medium">Connected</span>
                  )}
                </div>

                {!connected && (
                  <>
                    {/* Info section */}
                    <div className="p-3 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg">
                      <p className="text-sm text-accent-cyan font-medium mb-1">
                        {isTerminal ? 'Interactive terminal setup' : 'CLI-assisted authentication'}
                      </p>
                      <p className="text-xs text-accent-cyan/80">
                        {isTerminal
                          ? `Connect ${provider.displayName} using an interactive terminal. You'll see the CLI start up and can complete the OAuth login directly in the terminal.`
                          : `${provider.displayName} auth uses a CLI command to capture the OAuth callback locally. Click the button below and we'll show you a command with a unique session token to run in your terminal.`
                        }
                      </p>
                    </div>

                    {/* Connect button */}
                    <button
                      onClick={() => handleConnectProvider(provider)}
                      className="w-full flex items-center justify-center gap-2 p-3 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl hover:shadow-glow-cyan transition-all"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      Connect with {provider.displayName}
                    </button>
                  </>
                )}
              </div>
            );
          }

          // Standard provider button
          return (
            <button
              key={provider.id}
              onClick={() => !connected && handleConnectProvider(provider)}
              disabled={connected}
              className={`w-full flex items-center gap-3 p-4 bg-bg-tertiary rounded-xl border transition-colors text-left ${
                connected
                  ? 'border-green-500/50 cursor-default'
                  : 'border-border-subtle hover:border-accent-cyan/50'
              }`}
            >
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold flex-shrink-0 relative"
                style={{ backgroundColor: provider.color }}
              >
                {provider.displayName[0]}
                {connected && (
                  <div className="absolute -top-1 -right-1 w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
              </div>
              <div className="flex-1">
                <p className="text-white font-medium">{provider.displayName}</p>
                <p className="text-text-muted text-sm">{provider.description || provider.name}</p>
              </div>
              {connected ? (
                <span className="text-green-400 text-sm font-medium">Connected</span>
              ) : (
                <svg className="w-5 h-5 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
            </button>
          );
        })}
      </div>

      {/* Footer actions */}
      {(onConnectAnother || onContinue) && connectedProviders.length > 0 && (
        <div className="mt-6 pt-4 border-t border-border-subtle space-y-3">
          {onConnectAnother && (
            <button
              onClick={onConnectAnother}
              className="w-full py-3 px-4 bg-bg-tertiary border border-border-subtle text-white rounded-xl text-center hover:border-accent-cyan/50 transition-colors"
            >
              Connect Another Provider
            </button>
          )}
          {onContinue && (
            <button
              onClick={onContinue}
              className="w-full py-3 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl text-center hover:shadow-glow-cyan transition-all"
            >
              Continue to Dashboard
            </button>
          )}
        </div>
      )}

      {/* Skip link when no providers connected */}
      {connectedProviders.length === 0 && onContinue && (
        <div className="mt-6 text-center">
          <button
            onClick={onContinue}
            className="text-text-muted hover:text-white transition-colors text-sm"
          >
            Skip for now - I&apos;ll connect later
          </button>
        </div>
      )}
    </div>
  );
}
