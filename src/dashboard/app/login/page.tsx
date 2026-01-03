/**
 * Login Page - GitHub OAuth via Nango
 *
 * Uses Nango Connect UI for GitHub authentication with polling
 * to detect when login completes.
 */

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Nango, { ConnectUI } from '@nangohq/frontend';
import type { ConnectUIEvent } from '@nangohq/frontend';
import { cloudApi } from '../../lib/cloudApi';
import { LogoIcon } from '../../react-components/Logo';

type LoginState = 'idle' | 'loading' | 'connecting' | 'polling' | 'success' | 'error';

export default function LoginPage() {
  const [state, setState] = useState<LoginState>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const connectUIRef = useRef<ConnectUI | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (connectUIRef.current) {
        connectUIRef.current.close();
      }
    };
  }, []);

  // Poll for login completion
  const startPolling = useCallback((connId: string) => {
    setState('polling');

    // Poll every 1 second
    pollIntervalRef.current = setInterval(async () => {
      try {
        const result = await cloudApi.checkNangoLoginStatus(connId);
        if (result.success && result.data.ready) {
          // Login complete - stop polling and redirect
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
          }
          setState('success');
          // Redirect to dashboard after a brief success message
          setTimeout(() => {
            window.location.href = '/app';
          }, 1000);
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    }, 1000);

    // Timeout after 5 minutes
    setTimeout(() => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
        setState('error');
        setError('Login timed out. Please try again.');
      }
    }, 5 * 60 * 1000);
  }, []);

  // Handle login button click
  const handleLogin = useCallback(async () => {
    setState('loading');
    setError(null);

    try {
      // Create Nango instance and open Connect UI first (shows loading state)
      const nango = new Nango();

      const handleEvent = (event: ConnectUIEvent) => {
        if (event.type === 'connect') {
          // Connection successful - start polling
          const connectionId = event.payload.connectionId;
          startPolling(connectionId);
          if (connectUIRef.current) {
            connectUIRef.current.close();
          }
        } else if (event.type === 'close') {
          // User closed without connecting
          setState('idle');
        } else if (event.type === 'error') {
          setState('error');
          setError(event.payload.errorMessage || 'Connection failed');
          if (connectUIRef.current) {
            connectUIRef.current.close();
          }
        }
      };

      // Open Connect UI (shows loading until token is set)
      connectUIRef.current = nango.openConnectUI({
        onEvent: handleEvent,
      });
      connectUIRef.current.open();
      setState('connecting');

      // Get session token from backend and set it
      const sessionResult = await cloudApi.getNangoLoginSession();
      if (!sessionResult.success) {
        if (connectUIRef.current) {
          connectUIRef.current.close();
        }
        throw new Error(sessionResult.error || 'Failed to create login session');
      }

      // Set the session token - this enables the Connect UI
      connectUIRef.current.setSessionToken(sessionResult.data.sessionToken);
    } catch (err) {
      console.error('Login error:', err);
      setState('error');
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  }, [startPolling]);

  // Retry login
  const handleRetry = useCallback(() => {
    setState('idle');
    setError(null);
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }
  }, []);

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
          {state === 'success' ? (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-success/20 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Welcome!</h2>
              <p className="text-text-muted">Redirecting to dashboard...</p>
            </div>
          ) : state === 'error' ? (
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-error/20 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Login Failed</h2>
              <p className="text-text-muted mb-6">{error}</p>
              <button
                onClick={handleRetry}
                className="w-full py-3 px-4 bg-bg-tertiary border border-border-subtle rounded-xl text-white font-medium hover:bg-bg-hover transition-colors"
              >
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
              <h2 className="text-xl font-semibold text-white mb-2">Completing Login</h2>
              <p className="text-text-muted">Waiting for GitHub authentication...</p>
            </div>
          ) : (
            <div>
              <button
                onClick={handleLogin}
                disabled={state === 'loading' || state === 'connecting'}
                className="w-full py-4 px-6 bg-[#24292e] hover:bg-[#2f363d] border border-[#444d56] rounded-xl text-white font-medium flex items-center justify-center gap-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {state === 'loading' || state === 'connecting' ? (
                  <>
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <span>{state === 'loading' ? 'Loading...' : 'Opening GitHub...'}</span>
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
          )}
        </div>

        {/* Back to home */}
        <div className="mt-6 text-center">
          <a href="/" className="text-text-muted hover:text-white transition-colors">
            Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
