/**
 * Onboarding Page - Dedicated route for new users and post-deletion flow
 *
 * This page provides a cleaner onboarding experience separate from workspace selection.
 * It handles two scenarios:
 * 1. First-time users with no workspaces
 * 2. Users who just deleted their workspace
 *
 * URL params:
 * - reason=deleted: User just deleted a workspace
 * - reason=new: First-time user (default)
 */

'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { LogoIcon } from '../../../react-components/Logo';

interface Repository {
  id: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  syncStatus: string;
  hasNangoConnection: boolean;
}

type OnboardingReason = 'new' | 'deleted';

// Analytics event types for onboarding funnel
type OnboardingEvent =
  | 'onboarding_page_view'
  | 'onboarding_repo_selected'
  | 'onboarding_workspace_created'
  | 'onboarding_connect_repos_clicked'
  | 'onboarding_skipped';

// Simple analytics hook - can be extended to integrate with actual analytics service
function useOnboardingAnalytics() {
  const trackEvent = useCallback((event: OnboardingEvent, properties?: Record<string, unknown>) => {
    // Log to console in development
    if (process.env.NODE_ENV === 'development') {
      console.log('[Onboarding Analytics]', event, properties);
    }

    // TODO: Integrate with actual analytics service (e.g., Posthog, Mixpanel, etc.)
    // Example: posthog.capture(event, properties);

    // For now, send to a hypothetical analytics endpoint
    try {
      fetch('/api/analytics/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ event, properties, timestamp: Date.now() }),
      }).catch(() => {
        // Silently fail - analytics should not block user experience
      });
    } catch {
      // Silently fail
    }
  }, []);

  return { trackEvent };
}

function OnboardingContent() {
  const searchParams = useSearchParams();
  const reason = (searchParams.get('reason') as OnboardingReason) || 'new';

  const [repos, setRepos] = useState<Repository[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const { trackEvent } = useOnboardingAnalytics();

  // Fetch repositories and check session
  useEffect(() => {
    const init = async () => {
      try {
        // Check session
        const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });

        if (sessionRes.status === 404) {
          // Local mode - redirect to main app
          window.location.href = '/app';
          return;
        }

        // Capture CSRF token
        const token = sessionRes.headers.get('X-CSRF-Token');
        if (token) {
          setCsrfToken(token);
        }

        const session = await sessionRes.json();

        if (!session.authenticated) {
          window.location.href = '/login';
          return;
        }

        // Check if user already has workspaces - if so, redirect to /app
        const workspacesRes = await fetch('/api/workspaces', { credentials: 'include' });
        if (workspacesRes.ok) {
          const workspacesData = await workspacesRes.json();
          if ((workspacesData.workspaces || []).length > 0) {
            // User has workspaces, redirect to main app
            window.location.href = '/app';
            return;
          }
        }

        // Fetch repos
        const reposRes = await fetch('/api/github-app/repos', { credentials: 'include' });
        if (reposRes.ok) {
          const reposData = await reposRes.json();
          setRepos(reposData.repositories || []);
        }

        // Track page view
        trackEvent('onboarding_page_view', { reason });

        setIsLoading(false);
      } catch (err) {
        console.error('Onboarding init error:', err);
        setError(err instanceof Error ? err.message : 'Failed to initialize');
        setIsLoading(false);
      }
    };

    init();
  }, [reason, trackEvent]);

  const handleCreateWorkspace = useCallback(async (repoFullName: string) => {
    setIsCreating(true);
    setError(null);

    trackEvent('onboarding_repo_selected', { repository: repoFullName });

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

      trackEvent('onboarding_workspace_created', {
        workspaceId: data.workspaceId,
        repository: repoFullName,
      });

      // Redirect to main app - it will handle provisioning state
      window.location.href = '/app';
    } catch (err) {
      console.error('Create workspace error:', err);
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
      setIsCreating(false);
    }
  }, [csrfToken, trackEvent]);

  const handleConnectRepos = useCallback(() => {
    trackEvent('onboarding_connect_repos_clicked', { reason });
    window.location.href = '/connect-repos';
  }, [reason, trackEvent]);

  // Loading state
  if (isLoading) {
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

  // Creating workspace state
  if (isCreating) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
        <div className="text-center">
          <svg className="w-8 h-8 text-accent-cyan animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="mt-4 text-white font-medium">Creating your workspace...</p>
          <p className="mt-2 text-text-muted text-sm">This may take a few minutes</p>
        </div>
      </div>
    );
  }

  // Determine content based on reason
  const isDeletedWorkspace = reason === 'deleted';

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
        {/* Logo and Header */}
        <div className="flex flex-col items-center mb-8">
          <LogoIcon size={56} withGlow={true} />
          <h1 className="mt-6 text-3xl font-bold text-white">
            {isDeletedWorkspace ? 'Workspace Deleted' : 'Welcome to Agent Relay'}
          </h1>
          <p className="mt-3 text-text-muted text-center max-w-md">
            {isDeletedWorkspace
              ? 'Your workspace has been deleted. Create a new one to continue working with AI agents.'
              : 'Get started by creating your first workspace. Connect a repository and let AI agents help you build.'}
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-6 p-4 bg-error/10 border border-error/20 rounded-xl">
            <p className="text-error text-center">{error}</p>
          </div>
        )}

        {/* Main content card */}
        <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-8">
          {/* Step indicator for first-time users */}
          {!isDeletedWorkspace && (
            <div className="flex items-center justify-center gap-3 mb-8">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-accent-cyan flex items-center justify-center text-bg-deep font-semibold text-sm">
                  1
                </div>
                <span className="text-white font-medium">Select Repository</span>
              </div>
              <div className="w-12 h-px bg-border-subtle" />
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-bg-tertiary border border-border-subtle flex items-center justify-center text-text-muted font-semibold text-sm">
                  2
                </div>
                <span className="text-text-muted">Connect AI Provider</span>
              </div>
              <div className="w-12 h-px bg-border-subtle" />
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-bg-tertiary border border-border-subtle flex items-center justify-center text-text-muted font-semibold text-sm">
                  3
                </div>
                <span className="text-text-muted">Start Building</span>
              </div>
            </div>
          )}

          <h2 className="text-xl font-semibold text-white mb-2">
            {isDeletedWorkspace ? 'Create a New Workspace' : 'Choose a Repository'}
          </h2>
          <p className="text-text-muted mb-6">
            {isDeletedWorkspace
              ? 'Select a repository to create a new workspace for your AI agents.'
              : 'Your workspace will be set up with this repository. You can add more repos later.'}
          </p>

          {repos.length > 0 ? (
            <div className="space-y-3">
              {repos.map((repo) => (
                <button
                  key={repo.id}
                  onClick={() => handleCreateWorkspace(repo.fullName)}
                  disabled={isCreating}
                  className="w-full flex items-center gap-4 p-4 bg-bg-tertiary rounded-xl border border-border-subtle hover:border-accent-cyan/50 hover:bg-bg-hover transition-all text-left group disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="w-12 h-12 rounded-lg bg-bg-card border border-border-subtle flex items-center justify-center flex-shrink-0 group-hover:border-accent-cyan/30 transition-colors">
                    <svg className="w-6 h-6 text-text-muted group-hover:text-accent-cyan transition-colors" fill="currentColor" viewBox="0 0 16 16">
                      <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-medium truncate group-hover:text-accent-cyan transition-colors">
                      {repo.fullName}
                    </p>
                    <p className="text-text-muted text-sm mt-0.5">
                      {repo.isPrivate ? 'Private repository' : 'Public repository'} · {repo.defaultBranch}
                    </p>
                  </div>
                  <svg className="w-5 h-5 text-text-muted group-hover:text-accent-cyan group-hover:translate-x-1 transition-all" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 bg-bg-tertiary rounded-xl border border-border-subtle">
              <div className="w-16 h-16 mx-auto mb-4 bg-bg-card rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-text-muted" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">No Repositories Connected</h3>
              <p className="text-text-muted mb-6 max-w-sm mx-auto">
                Connect your GitHub repositories to create a workspace and start working with AI agents.
              </p>
              <button
                onClick={handleConnectRepos}
                className="inline-flex items-center gap-2 py-3 px-6 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl hover:shadow-glow-cyan transition-all"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                Connect GitHub
              </button>
            </div>
          )}
        </div>

        {/* Footer navigation */}
        <div className="mt-8 flex justify-center gap-6 text-sm">
          {repos.length > 0 && (
            <button
              onClick={handleConnectRepos}
              className="text-text-muted hover:text-white transition-colors"
            >
              Connect More Repositories
            </button>
          )}
          <a
            href="/app"
            className="text-text-muted hover:text-white transition-colors"
          >
            Back to Dashboard
          </a>
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

// Wrap in Suspense for useSearchParams
export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex items-center justify-center">
          <div className="text-center">
            <svg className="w-8 h-8 text-accent-cyan animate-spin mx-auto" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p className="mt-4 text-text-muted">Loading...</p>
          </div>
        </div>
      }
    >
      <OnboardingContent />
    </Suspense>
  );
}
