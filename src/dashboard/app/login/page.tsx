/**
 * Login Page - GitHub OAuth via Nango
 *
 * Key: Initialize Nango on page load, not on click.
 * This avoids popup blockers by ensuring openConnectUI is synchronous.
 * See: https://arveknudsen.com/posts/avoiding-popup-blocking-when-authing-with-google/
 */

'use client';

import React, { useState, useEffect, useRef } from 'react';
import Nango from '@nangohq/frontend';
import { LogoIcon } from '../../react-components/Logo';

export default function LoginPage() {
  const [isReady, setIsReady] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authStatus, setAuthStatus] = useState<string>('');
  const [error, setError] = useState('');

  // Store Nango instance and session token - initialized on mount
  const nangoRef = useRef<InstanceType<typeof Nango> | null>(null);

  // Initialize Nango with session token on page load
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        const response = await fetch('/api/auth/nango/login-session', {
          credentials: 'include',
        });
        const data = await response.json();

        if (!mounted) return;

        if (!response.ok || !data.sessionToken) {
          setError('Failed to initialize. Please refresh the page.');
          return;
        }

        // Create Nango instance NOW, not on click
        nangoRef.current = new Nango({ connectSessionToken: data.sessionToken });
        setIsReady(true);
      } catch (err) {
        if (mounted) {
          console.error('Init error:', err);
          setError('Failed to initialize. Please refresh the page.');
        }
      }
    };

    init();
    return () => { mounted = false; };
  }, []);

  const checkAuthStatus = async (connectionId: string): Promise<{ ready: boolean; hasRepos?: boolean }> => {
    const response = await fetch(`/api/auth/nango/login-status/${connectionId}`, {
      credentials: 'include',
    });
    if (!response.ok) {
      throw new Error('Auth status not ready');
    }
    return response.json();
  };

  const handleAuthSuccess = async (connectionId: string) => {
    try {
      setAuthStatus('Completing authentication...');

      const pollStartTime = Date.now();
      const maxPollTime = 30000;
      const pollInterval = 1000;

      const pollForAuth = async (): Promise<void> => {
        const elapsed = Date.now() - pollStartTime;

        if (elapsed > maxPollTime) {
          throw new Error('Authentication timed out. Please try again.');
        }

        try {
          const result = await checkAuthStatus(connectionId);
          if (result && result.ready) {
            // Redirect to connect-repos if no repos, otherwise to app
            window.location.href = result.hasRepos ? '/app' : '/connect-repos';
            return;
          }

          await new Promise(resolve => setTimeout(resolve, pollInterval));
          return pollForAuth();
        } catch {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          return pollForAuth();
        }
      };

      await pollForAuth();
    } catch (err) {
      console.error('[AUTH] Authentication error:', err);
      setError(err instanceof Error ? err.message : 'Authentication failed');
      setIsAuthenticating(false);
      setAuthStatus('');
    }
  };

  // Use nango.auth() instead of openConnectUI to avoid popup blocker issues
  const handleGitHubAuth = async () => {
    if (!nangoRef.current) {
      setError('Not ready. Please refresh the page.');
      return;
    }

    setIsAuthenticating(true);
    setError('');
    setAuthStatus('Connecting to GitHub...');

    try {
      const result = await nangoRef.current.auth('github');
      if (result && 'connectionId' in result) {
        await handleAuthSuccess(result.connectionId);
      } else {
        throw new Error('No connection ID returned');
      }
    } catch (err: unknown) {
      const error = err as Error & { type?: string };
      console.error('GitHub auth error:', error);

      // Don't show error for user-cancelled auth
      if (error.type === 'user_cancelled' || error.message?.includes('closed')) {
        setIsAuthenticating(false);
        setAuthStatus('');
        // Re-initialize for next attempt
        fetch('/api/auth/nango/login-session', { credentials: 'include' })
          .then(res => res.json())
          .then(data => {
            if (data.sessionToken) {
              nangoRef.current = new Nango({ connectSessionToken: data.sessionToken });
              setIsReady(true);
            }
          });
        return;
      }

      setError(error.message || 'Authentication failed');
      setIsAuthenticating(false);
      setAuthStatus('');
    }
  };

  const isLoading = !isReady || isAuthenticating;

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
      <div className="relative z-10 w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <LogoIcon size={48} withGlow={true} />
          <h1 className="mt-4 text-2xl font-bold text-white">Agent Relay</h1>
          <p className="mt-2 text-text-muted">Sign in to continue</p>
        </div>

        {/* Login Card */}
        <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-8 shadow-xl">
          <div>
            {error && (
              <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg">
                <p className="text-error text-sm">{error}</p>
              </div>
            )}

            <button
              type="button"
              onClick={handleGitHubAuth}
              disabled={isLoading}
              className="w-full py-4 px-6 bg-[#24292e] hover:bg-[#2f363d] border border-[#444d56] rounded-xl text-white font-medium flex items-center justify-center gap-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {!isReady ? (
                <>
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>Loading...</span>
                </>
              ) : isAuthenticating ? (
                <>
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>{authStatus || 'Connecting...'}</span>
                </>
              ) : (
                <>
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                  <span>Continue with GitHub</span>
                </>
              )}
            </button>

            <p className="mt-6 text-center text-text-muted text-sm">
              By signing in, you agree to our{' '}
              <a href="/terms" className="text-accent-cyan hover:underline">Terms of Service</a>
              {' '}and{' '}
              <a href="/privacy" className="text-accent-cyan hover:underline">Privacy Policy</a>
            </p>
          </div>
        </div>

        {/* Sign up link */}
        <div className="mt-6 text-center">
          <p className="text-text-muted">
            Don't have an account?{' '}
            <a href="/signup" className="text-accent-cyan hover:underline font-medium">
              Sign up
            </a>
          </p>
        </div>

        {/* Back to home */}
        <div className="mt-4 text-center">
          <a href="/" className="text-text-muted hover:text-white transition-colors text-sm">
            Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
