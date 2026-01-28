/**
 * Providers Page
 *
 * Connect AI providers (Anthropic, OpenAI, etc.) to enable workspace creation.
 * Uses the shared ProviderConnectionList component for consistent UI with /app onboarding.
 */

'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { LogoIcon } from '../../react-components/Logo';
import { ProviderConnectionList, type ProviderInfo } from '../../react-components/ProviderConnectionList';

interface BackendProvider {
  id: string;
  name: string;
  displayName: string;
  description: string;
  color: string;
  isConnected: boolean;
  connectedAs?: string;
  cliCommand?: string;
}

// Available AI providers - same as /app page
const AI_PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic', displayName: 'Claude', color: '#D97757', cliCommand: 'claude' },
  { id: 'codex', name: 'OpenAI', displayName: 'Codex', color: '#10A37F', cliCommand: 'codex login', supportsDeviceFlow: true, requiresUrlCopy: true },
  { id: 'google', name: 'Google', displayName: 'Gemini', color: '#4285F4', cliCommand: 'gemini' },
  { id: 'opencode', name: 'OpenCode', displayName: 'OpenCode', color: '#00D4AA', cliCommand: 'opencode', comingSoon: true },
  { id: 'droid', name: 'Factory', displayName: 'Droid', color: '#6366F1', cliCommand: 'droid', comingSoon: true },
  { id: 'cursor', name: 'Cursor', displayName: 'Cursor', color: '#7C3AED', cliCommand: 'agent' },
];

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

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);

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
        // Extract connected provider IDs
        const connected = (data.providers || [])
          .filter((p: BackendProvider) => p.isConnected && p.id !== 'github')
          .map((p: BackendProvider) => p.id);
        setConnectedProviders(connected);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load providers');
      } finally {
        setLoading(false);
      }
    };

    fetchProviders();
  }, []);

  const handleProviderConnected = (providerId: string) => {
    setConnectedProviders(prev => [...new Set([...prev, providerId])]);
  };

  const handleContinue = () => {
    window.location.href = workspaceId ? `/app?workspace=${workspaceId}` : '/app';
  };

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
            Connect your AI providers to start using agents.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-4 bg-error/10 border border-error/20 rounded-xl">
            <p className="text-error">{error}</p>
          </div>
        )}

        {/* No workspace warning */}
        {!workspaceId && (
          <div className="mb-4 p-4 bg-warning/10 border border-warning/20 rounded-xl">
            <p className="text-warning text-sm">
              <strong>Note:</strong> CLI-based authentication requires a running workspace.
              Please{' '}
              <a href="/app" className="underline hover:no-underline">create a workspace</a> first.
            </p>
          </div>
        )}

        {/* Shared provider connection component */}
        {workspaceId ? (
          <ProviderConnectionList
            providers={AI_PROVIDERS}
            connectedProviders={connectedProviders}
            workspaceId={workspaceId}
            csrfToken={csrfToken || undefined}
            onProviderConnected={handleProviderConnected}
            onContinue={handleContinue}
            showDetailedInfo={true}
          />
        ) : (
          <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-6 text-center">
            <p className="text-text-muted mb-4">
              A workspace is required to connect providers via CLI authentication.
            </p>
            <a
              href="/app"
              className="inline-block py-3 px-6 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl hover:shadow-glow-cyan transition-all"
            >
              Create a Workspace
            </a>
          </div>
        )}
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
