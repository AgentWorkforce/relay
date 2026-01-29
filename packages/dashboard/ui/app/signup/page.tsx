/**
 * Signup Page - GitHub OAuth via Nango or Email/Password
 *
 * Key: Initialize Nango on page load, not on click.
 * This avoids popup blockers by ensuring openConnectUI is synchronous.
 */

'use client';

import React, { useState, useEffect, useRef } from 'react';
import Nango from '@nangohq/frontend';
import { LogoIcon } from '../../react-components/Logo';

type AuthMethod = 'github' | 'email';

export default function SignupPage() {
  const [authMethod, setAuthMethod] = useState<AuthMethod>('github');
  const [isReady, setIsReady] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authStatus, setAuthStatus] = useState<string>('');
  const [error, setError] = useState('');
  const [redirectTarget, setRedirectTarget] = useState<string>('/app');
  const [showSuccess, setShowSuccess] = useState(false);

  // Email signup form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  // Store Nango instance - initialized on mount
  const nangoRef = useRef<InstanceType<typeof Nango> | null>(null);

  // Initialize Nango with session token on page load
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      // Check if already logged in
      try {
        const sessionRes = await fetch('/api/auth/session', { credentials: 'include' });
        const session = await sessionRes.json();
        if (session.authenticated) {
          await handlePostAuthRedirect();
          return;
        }
      } catch {
        // Not logged in, continue
      }

      // Get Nango session token
      try {
        const response = await fetch('/api/auth/nango/login-session', {
          credentials: 'include',
        });
        const data = await response.json();

        if (!mounted) return;

        if (!response.ok || !data.sessionToken) {
          // Don't set error - email signup doesn't need Nango
          setIsReady(true);
          return;
        }

        // Create Nango instance NOW, not on click
        nangoRef.current = new Nango({ connectSessionToken: data.sessionToken });
        setIsReady(true);
      } catch (err) {
        if (mounted) {
          console.error('Init error:', err);
          // Still allow email signup even if Nango fails
          setIsReady(true);
        }
      }
    };

    init();
    return () => { mounted = false; };
  }, []);

  const handlePostAuthRedirect = async () => {
    setAuthStatus('Setting up your account...');

    try {
      const response = await fetch('/api/github-app/repos', { credentials: 'include' });
      const data = await response.json();

      if (data.repositories && data.repositories.length > 0) {
        setRedirectTarget('/app');
      } else {
        setRedirectTarget('/connect-repos');
      }

      setShowSuccess(true);

      setTimeout(() => {
        window.location.href = data.repositories && data.repositories.length > 0
          ? '/app'
          : '/connect-repos';
      }, 1500);
    } catch (err) {
      console.error('Error checking repos:', err);
      setRedirectTarget('/connect-repos');
      setShowSuccess(true);
      setTimeout(() => {
        window.location.href = '/connect-repos';
      }, 1500);
    }
  };

  const checkAuthStatus = async (connectionId: string): Promise<{ ready: boolean; needsEmail?: boolean }> => {
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
            // If user needs to provide email, redirect to complete-profile
            if (result.needsEmail) {
              window.location.href = '/complete-profile';
              return;
            }
            await handlePostAuthRedirect();
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
      setError('GitHub signup not available. Please use email signup or refresh the page.');
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

  // Handle email signup
  const handleEmailSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validate passwords match
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    // Validate password length
    if (password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    setIsAuthenticating(true);
    setAuthStatus('Creating your account...');

    try {
      // Get CSRF token first
      const csrfResponse = await fetch('/api/auth/session', { credentials: 'include' });
      const csrfToken = csrfResponse.headers.get('x-csrf-token');

      const response = await fetch('/api/auth/email/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken && { 'x-csrf-token': csrfToken }),
        },
        credentials: 'include',
        body: JSON.stringify({
          email,
          password,
          displayName: displayName || undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Signup failed');
        setIsAuthenticating(false);
        setAuthStatus('');
        return;
      }

      // Success - redirect to app
      setAuthStatus('Account created! Redirecting...');
      setShowSuccess(true);
      setRedirectTarget('/app');

      setTimeout(() => {
        window.location.href = '/app';
      }, 1500);
    } catch (err) {
      console.error('Email signup error:', err);
      setError('Failed to connect. Please try again.');
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

      {/* Glow orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-80 h-80 bg-accent-cyan/20 rounded-full blur-[100px]" />
        <div className="absolute -bottom-40 -right-40 w-80 h-80 bg-[#00ffc8]/15 rounded-full blur-[100px]" />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <LogoIcon size={56} withGlow={true} />
          <h1 className="mt-4 text-3xl font-bold text-white">Get Started</h1>
          <p className="mt-2 text-text-muted text-center">
            Create your account and start orchestrating AI agents
          </p>
        </div>

        {/* Signup Card */}
        <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-8 shadow-xl">
          {showSuccess ? (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-success/20 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Welcome to Agent Relay!</h2>
              <p className="text-text-muted">
                {redirectTarget === '/connect-repos'
                  ? "Let's connect your repositories..."
                  : 'Redirecting to dashboard...'}
              </p>
            </div>
          ) : isAuthenticating ? (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center">
                <svg className="w-8 h-8 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Creating Account</h2>
              <p className="text-text-muted">{authStatus || 'Setting things up...'}</p>
            </div>
          ) : (
            <div>
              {error && (
                <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg">
                  <p className="text-error text-sm">{error}</p>
                </div>
              )}

              {/* Auth method tabs */}
              <div className="flex mb-6 bg-bg-secondary/50 rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => setAuthMethod('github')}
                  className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                    authMethod === 'github'
                      ? 'bg-bg-primary text-white shadow-sm'
                      : 'text-text-muted hover:text-white'
                  }`}
                >
                  GitHub
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMethod('email')}
                  className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                    authMethod === 'email'
                      ? 'bg-bg-primary text-white shadow-sm'
                      : 'text-text-muted hover:text-white'
                  }`}
                >
                  Email
                </button>
              </div>

              {authMethod === 'github' ? (
                <>
                  {/* Features list */}
                  <div className="mb-6 space-y-3">
                    <div className="flex items-center gap-3 text-sm text-text-secondary">
                      <div className="w-8 h-8 rounded-lg bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
                        <svg className="w-4 h-4 text-accent-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                      </div>
                      <span>Deploy AI agents in seconds</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-text-secondary">
                      <div className="w-8 h-8 rounded-lg bg-[#00ffc8]/10 flex items-center justify-center flex-shrink-0">
                        <svg className="w-4 h-4 text-[#00ffc8]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                        </svg>
                      </div>
                      <span>Real-time agent collaboration</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-text-secondary">
                      <div className="w-8 h-8 rounded-lg bg-[#0891b2]/10 flex items-center justify-center flex-shrink-0">
                        <svg className="w-4 h-4 text-[#0891b2]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                        </svg>
                      </div>
                      <span>Secure credential management</span>
                    </div>
                  </div>

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
                    ) : (
                      <>
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                        </svg>
                        <span>Sign up with GitHub</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <form onSubmit={handleEmailSignup} className="space-y-4">
                  <div>
                    <label htmlFor="displayName" className="block text-sm font-medium text-text-secondary mb-2">
                      Name <span className="text-text-muted">(optional)</span>
                    </label>
                    <input
                      type="text"
                      id="displayName"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      disabled={isAuthenticating}
                      className="w-full px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-white placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-cyan/50 focus:border-accent-cyan disabled:opacity-50"
                      placeholder="Your name"
                    />
                  </div>
                  <div>
                    <label htmlFor="email" className="block text-sm font-medium text-text-secondary mb-2">
                      Email
                    </label>
                    <input
                      type="email"
                      id="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      disabled={isAuthenticating}
                      className="w-full px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-white placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-cyan/50 focus:border-accent-cyan disabled:opacity-50"
                      placeholder="you@example.com"
                    />
                  </div>
                  <div>
                    <label htmlFor="password" className="block text-sm font-medium text-text-secondary mb-2">
                      Password
                    </label>
                    <input
                      type="password"
                      id="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      disabled={isAuthenticating}
                      className="w-full px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-white placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-cyan/50 focus:border-accent-cyan disabled:opacity-50"
                      placeholder="At least 8 characters"
                    />
                  </div>
                  <div>
                    <label htmlFor="confirmPassword" className="block text-sm font-medium text-text-secondary mb-2">
                      Confirm Password
                    </label>
                    <input
                      type="password"
                      id="confirmPassword"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      disabled={isAuthenticating}
                      className="w-full px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-white placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-cyan/50 focus:border-accent-cyan disabled:opacity-50"
                      placeholder="Confirm your password"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading || !email || !password || !confirmPassword}
                    className="w-full py-4 px-6 bg-accent-cyan hover:bg-accent-cyan/90 rounded-xl text-black font-medium flex items-center justify-center gap-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isAuthenticating ? (
                      <>
                        <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>{authStatus || 'Creating account...'}</span>
                      </>
                    ) : (
                      <span>Create Account</span>
                    )}
                  </button>
                </form>
              )}

              <p className="mt-6 text-center text-text-muted text-sm">
                By signing up, you agree to our{' '}
                <a href="/terms" className="text-accent-cyan hover:underline">Terms of Service</a>
                {' '}and{' '}
                <a href="/privacy" className="text-accent-cyan hover:underline">Privacy Policy</a>
              </p>
            </div>
          )}
        </div>

        {/* Already have account */}
        <div className="mt-6 text-center">
          <p className="text-text-muted">
            Already have an account?{' '}
            <a href="/login" className="text-accent-cyan hover:underline font-medium">
              Sign in
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
