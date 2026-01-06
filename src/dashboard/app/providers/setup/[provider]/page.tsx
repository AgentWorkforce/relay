/**
 * Provider Setup Page (Server Component)
 *
 * Renders the client component with static params for Next.js export.
 */

import { Suspense } from 'react';
import { ProviderSetupClient } from './ProviderSetupClient';
import { PROVIDER_CONFIGS } from './constants';

// Required for static export with dynamic routes
export function generateStaticParams() {
  return Object.keys(PROVIDER_CONFIGS).map((provider) => ({
    provider,
  }));
}

function LoadingFallback() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
      <div className="flex items-center gap-3">
        <svg className="w-6 h-6 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-text-muted">Loading setup...</span>
      </div>
    </div>
  );
}

export default function ProviderSetupPage({
  params,
}: {
  params: { provider: string };
}) {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ProviderSetupClient provider={params.provider} />
    </Suspense>
  );
}
