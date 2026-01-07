/**
 * Provider Setup Client Component
 *
 * Full-page interactive terminal for provider authentication and setup.
 * Uses the shared TerminalProviderSetup component.
 */

'use client';

import React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LogoIcon } from '../../../../react-components/Logo';
import { TerminalProviderSetup } from '../../../../react-components/TerminalProviderSetup';
import { PROVIDER_CONFIGS } from './constants';

export interface ProviderSetupClientProps {
  provider: string;
}

export function ProviderSetupClient({ provider }: ProviderSetupClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get('workspace');

  const config = PROVIDER_CONFIGS[provider];

  if (!config) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <p className="text-error">Unknown provider: {provider}</p>
          <a href="/providers" className="mt-4 text-accent-cyan hover:underline">
            Back to providers
          </a>
        </div>
      </div>
    );
  }

  if (!workspaceId) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <p className="text-error">No workspace specified</p>
          <a href="/app" className="mt-4 text-accent-cyan hover:underline">
            Back to dashboard
          </a>
        </div>
      </div>
    );
  }

  const handleSuccess = () => {
    router.push(`/app?workspace=${workspaceId}`);
  };

  const handleCancel = () => {
    router.push(`/app?workspace=${workspaceId}`);
  };

  const handleConnectAnother = () => {
    // Navigate to providers page to select another provider
    router.push(`/providers?workspace=${workspaceId}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <a href="/app" className="flex items-center gap-3 group">
            <LogoIcon className="w-8 h-8 text-accent-cyan group-hover:scale-105 transition-transform" />
            <span className="text-lg font-bold text-white">Agent Relay</span>
          </a>
          <a
            href={`/app?workspace=${workspaceId}`}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            Skip for now →
          </a>
        </div>

        {/* Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-4">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-xl shadow-lg"
              style={{
                backgroundColor: config.color,
                boxShadow: `0 4px 20px ${config.color}40`,
              }}
            >
              {config.displayName[0]}
            </div>
            <h1 className="text-2xl font-bold text-white">
              Set up {config.displayName}
            </h1>
          </div>
          <p className="text-text-muted">
            Complete the authentication flow in the interactive terminal below
          </p>
        </div>

        {/* Terminal Setup Component */}
        <TerminalProviderSetup
          provider={{
            id: config.id,
            name: config.name,
            displayName: config.displayName,
            color: config.color,
          }}
          workspaceId={workspaceId}
          maxHeight="500px"
          showHeader={true}
          onSuccess={handleSuccess}
          onCancel={handleCancel}
          onConnectAnother={handleConnectAnother}
          onError={(err) => console.error('Setup error:', err)}
          className="shadow-2xl"
        />

        {/* Help text */}
        <div className="mt-6 p-4 bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-xl">
          <h3 className="text-white font-medium mb-2">How this works:</h3>
          <ol className="text-sm text-text-muted space-y-1 list-decimal list-inside">
            <li>The terminal above is interactive - respond to any prompts by typing directly</li>
            <li>When a login URL appears, we&apos;ll detect it and show a popup to help you open it</li>
            <li>Complete the login in your browser, then return here</li>
            <li>Answer any remaining prompts (skills, permissions, etc.) in the terminal</li>
            <li>Once connected, click &quot;Done - Continue&quot; to go to the dashboard</li>
          </ol>
        </div>

        {/* Fallback link */}
        <div className="mt-4 text-center">
          <a
            href={`/providers?connect=${config.id}&workspace=${workspaceId}`}
            className="text-sm text-text-muted hover:text-accent-cyan transition-colors"
          >
            Having trouble? Try the popup-based login instead →
          </a>
        </div>
      </div>
    </div>
  );
}

export default ProviderSetupClient;
