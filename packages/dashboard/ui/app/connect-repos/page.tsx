/**
 * Connect Repos Page - GitHub App OAuth via Nango
 *
 * Key: Initialize Nango on page load, not on click.
 * This avoids popup blockers by ensuring openConnectUI is synchronous.
 */

'use client';

import React, { useState, useEffect, useRef } from 'react';
import Nango from '@nangohq/frontend';
import { LogoIcon } from '../../react-components/Logo';

type ConnectState = 'checking' | 'ready' | 'connecting' | 'polling' | 'pending-approval' | 'success' | 'error';

interface ConnectedRepo {
  id: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
}

export default function ConnectReposPage() {
  const [state, setState] = useState<ConnectState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<ConnectedRepo[]>([]);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Store Nango instance - initialized on mount
  const nangoRef = useRef<InstanceType<typeof Nango> | null>(null);

  // Check session and initialize Nango on mount
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        // Check if authenticated
        const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
        const session = await sessionRes.json();
        if (!session.authenticated) {
          window.location.href = '/login';
          return;
        }

        if (!mounted) return;

        // Get Nango session token for repo connection
        const nangoRes = await fetch('/api/auth/nango/repo-session', {
          credentials: 'include',
        });
        const nangoData = await nangoRes.json();

        if (!mounted) return;

        if (!nangoRes.ok || !nangoData.sessionToken) {
          if (nangoData?.sessionExpired || nangoData?.code === 'SESSION_EXPIRED') {
            window.location.href = '/login';
            return;
          }
          setError('Failed to initialize. Please refresh the page.');
          setState('error');
          return;
        }

        // Create Nango instance NOW, not on click
        nangoRef.current = new Nango({ connectSessionToken: nangoData.sessionToken });
        setState('ready');
      } catch {
        if (mounted) {
          window.location.href = '/login';
        }
      }
    };

    init();
    return () => { mounted = false; };
  }, []);

  const checkRepoStatus = async (connectionId: string): Promise<{
    ready: boolean;
    pendingApproval?: boolean;
    message?: string;
    repos?: ConnectedRepo[];
  }> => {
    const response = await fetch(`/api/auth/nango/repo-status/${connectionId}`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error('Status not ready');
    }
    return response.json();
  };

  const handleAuthSuccess = async (connectionId: string) => {
    try {
      setState('polling');
      setStatusMessage('Syncing repositories...');

      const pollStartTime = Date.now();
      const maxPollTime = 5 * 60 * 1000;
      const pollInterval = 2000;

      const pollForRepos = async (): Promise<void> => {
        const elapsed = Date.now() - pollStartTime;

        if (elapsed > maxPollTime) {
          throw new Error('Connection timed out. Please try again.');
        }

        try {
          const result = await checkRepoStatus(connectionId);
          if (result.pendingApproval) {
            setState('pending-approval');
            setPendingMessage(result.message || 'Waiting for organization admin approval');
            return;
          } else if (result.ready && result.repos) {
            setRepos(result.repos);
            setState('success');
            return;
          }

          await new Promise(resolve => setTimeout(resolve, pollInterval));
          return pollForRepos();
        } catch {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          return pollForRepos();
        }
      };

      await pollForRepos();
    } catch (err) {
      console.error('[AUTH] Error:', err);
      setError(err instanceof Error ? err.message : 'Connection failed');
      setState('error');
      setStatusMessage('');
    }
  };

  // Use nango.auth() instead of openConnectUI to avoid popup blocker issues
  const handleConnect = async () => {
    if (!nangoRef.current) {
      setError('Not ready. Please refresh the page.');
      return;
    }

    setState('connecting');
    setError(null);
    setStatusMessage('Connecting to GitHub...');

    try {
      // Use github-app-oauth for GitHub App installation
      const result = await nangoRef.current.auth('github-app-oauth');
      if (result && 'connectionId' in result) {
        await handleAuthSuccess(result.connectionId);
      } else {
        throw new Error('No connection ID returned');
      }
    } catch (err: unknown) {
      const error = err as Error & { type?: string };
      console.error('GitHub App auth error:', error);

      // Don't show error for user-cancelled auth
      if (error.type === 'user_cancelled' || error.message?.includes('closed')) {
        setStatusMessage('');
        // Re-initialize for next attempt
        fetch('/api/auth/nango/repo-session', { credentials: 'include' })
          .then(res => res.json())
          .then(data => {
            if (data.sessionToken) {
              nangoRef.current = new Nango({ connectSessionToken: data.sessionToken });
              setState('ready');
            }
          });
        return;
      }

      setError(error.message || 'Connection failed');
      setState('error');
      setStatusMessage('');
    }
  };

  const handleRetry = async () => {
    setError(null);
    setRepos([]);
    setPendingMessage(null);
    setStatusMessage('');
    setState('checking');

    // Re-initialize Nango for the retry
    try {
      const nangoRes = await fetch('/api/auth/nango/repo-session', {
        credentials: 'include',
      });
      const nangoData = await nangoRes.json();

      if (!nangoRes.ok || !nangoData.sessionToken) {
        if (nangoData?.sessionExpired || nangoData?.code === 'SESSION_EXPIRED') {
          window.location.href = '/login';
          return;
        }
        setError('Failed to initialize. Please refresh the page.');
        setState('error');
        return;
      }

      nangoRef.current = new Nango({ connectSessionToken: nangoData.sessionToken });
      setState('ready');
    } catch {
      setError('Failed to initialize. Please refresh the page.');
      setState('error');
    }
  };

  const handleContinue = () => {
    window.location.href = '/app';
  };

  if (state === 'checking') {
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

  const isConnecting = state === 'connecting' || state === 'polling';
  const isReady = state === 'ready';

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex flex-col items-center justify-center p-4">
      {/* Background grid */}
      <div className="fixed inset-0 opacity-10">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `linear-gradient(rgba(0, 217, 255, 0.1) 1px, transparent 1px),
                             linear-gradient(90deg, rgba(0, 217, 255, 0.1) 1px, transparent 1px)`,
            backgroundSize: '50px 50px',
          }}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-lg">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <LogoIcon size={48} withGlow={true} />
          <h1 className="mt-4 text-2xl font-bold text-white">Connect Repositories</h1>
          <p className="mt-2 text-text-muted text-center">
            Connect your GitHub repositories to enable agent access
          </p>
        </div>

        {/* Connect Card */}
        <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-8 shadow-xl">
          {state === 'success' ? (
            <div>
              <div className="w-16 h-16 mx-auto mb-4 bg-success/20 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-4 text-center">Repositories Connected!</h2>

              <div className="max-h-60 overflow-y-auto mb-6 space-y-2">
                {repos.map((repo) => (
                  <div key={repo.id} className="flex items-center gap-3 p-3 bg-bg-tertiary rounded-lg">
                    <svg className="w-5 h-5 text-text-muted flex-shrink-0" fill="currentColor" viewBox="0 0 16 16">
                      <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium truncate">{repo.fullName}</p>
                      <p className="text-text-muted text-sm">{repo.isPrivate ? 'Private' : 'Public'}</p>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={handleContinue}
                className="w-full py-3 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl hover:shadow-glow-cyan transition-all"
              >
                Continue to Dashboard
              </button>
            </div>
          ) : state === 'pending-approval' ? (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-warning/20 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Approval Pending</h2>
              <p className="text-text-muted mb-6">{pendingMessage}</p>
              <p className="text-sm text-text-muted mb-6">
                An organization admin needs to approve the GitHub App installation.
              </p>
              <div className="flex gap-3">
                <button onClick={handleRetry} className="flex-1 py-3 px-4 bg-bg-tertiary border border-border-subtle rounded-xl text-white font-medium hover:bg-bg-hover transition-colors">
                  Try Again
                </button>
                <button onClick={handleContinue} className="flex-1 py-3 px-4 bg-bg-tertiary border border-border-subtle rounded-xl text-white font-medium hover:bg-bg-hover transition-colors">
                  Skip for Now
                </button>
              </div>
            </div>
          ) : state === 'error' ? (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-error/20 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Connection Failed</h2>
              <p className="text-text-muted mb-6">{error}</p>
              <button onClick={handleRetry} className="w-full py-3 px-4 bg-bg-tertiary border border-border-subtle rounded-xl text-white font-medium hover:bg-bg-hover transition-colors">
                Try Again
              </button>
            </div>
          ) : state === 'polling' ? (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center">
                <svg className="w-8 h-8 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Syncing Repositories</h2>
              <p className="text-text-muted">{statusMessage || 'Fetching your repositories...'}</p>
            </div>
          ) : (
            <div>
              {error && (
                <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg">
                  <p className="text-error text-sm">{error}</p>
                </div>
              )}

              <div className="mb-6 p-4 bg-bg-tertiary rounded-lg border border-border-subtle">
                <h3 className="font-medium text-white mb-2">What this enables:</h3>
                <ul className="space-y-2 text-sm text-text-muted">
                  <li className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-success mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span>Agents can clone and work on your repositories</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-success mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span>Create issues, PRs, and comments on your behalf</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-success mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span>Secure token management - we never store your password</span>
                  </li>
                </ul>
              </div>

              <button
                onClick={handleConnect}
                disabled={!isReady || isConnecting}
                className="w-full py-4 px-6 bg-[#24292e] hover:bg-[#2f363d] border border-[#444d56] rounded-xl text-white font-medium flex items-center justify-center gap-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isConnecting ? (
                  <>
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>{statusMessage || 'Connecting...'}</span>
                  </>
                ) : (
                  <>
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                    </svg>
                    <span>Connect GitHub Repositories</span>
                  </>
                )}
              </button>

              <button onClick={handleContinue} className="w-full mt-3 py-3 px-4 text-text-muted hover:text-white transition-colors text-sm">
                Skip for now
              </button>
            </div>
          )}
        </div>

        <div className="mt-6 text-center">
          <a href="/app" className="text-text-muted hover:text-white transition-colors">
            Back to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
