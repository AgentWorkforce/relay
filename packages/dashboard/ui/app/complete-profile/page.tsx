/**
 * Complete Profile Page
 *
 * Prompts users to provide missing information after GitHub OAuth signup.
 * Currently used to collect email address for GitHub users whose email
 * is not publicly available.
 */

'use client';

import React, { useState, useEffect } from 'react';
import { LogoIcon } from '../../react-components/Logo';

export default function CompleteProfilePage() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [user, setUser] = useState<{
    githubUsername?: string;
    avatarUrl?: string;
    email?: string;
  } | null>(null);

  // Check if user is logged in and needs email
  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (!response.ok) {
          // Not logged in - redirect to login
          window.location.href = '/login';
          return;
        }

        const data = await response.json();

        // If user already has email, redirect to app
        if (data.user?.email) {
          window.location.href = '/app';
          return;
        }

        setUser(data.user);
        setIsLoading(false);
      } catch (err) {
        console.error('Error checking session:', err);
        window.location.href = '/login';
      }
    };

    checkSession();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      // Get CSRF token first
      const csrfResponse = await fetch('/api/auth/session', { credentials: 'include' });
      const csrfToken = csrfResponse.headers.get('x-csrf-token');

      const response = await fetch('/api/auth/email/set-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken && { 'x-csrf-token': csrfToken }),
        },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to set email');
        setIsSubmitting(false);
        return;
      }

      // Success - redirect to app
      window.location.href = '/app';
    } catch (err) {
      console.error('Error setting email:', err);
      setError('Failed to connect. Please try again.');
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex flex-col items-center justify-center p-4">
        <div className="relative z-10 w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            <LogoIcon size={48} withGlow={true} />
            <h1 className="mt-4 text-2xl font-bold text-white">Agent Relay</h1>
            <p className="mt-2 text-text-muted">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

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
          <h1 className="mt-4 text-2xl font-bold text-white">Almost there!</h1>
          <p className="mt-2 text-text-muted text-center">
            Please provide your email to complete your account setup
          </p>
        </div>

        {/* Card */}
        <div className="bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-2xl p-8 shadow-xl">
          {/* User info */}
          {user && (
            <div className="flex items-center gap-4 mb-6 pb-6 border-b border-border-subtle">
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.githubUsername || 'User'}
                  className="w-12 h-12 rounded-full"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-bg-secondary flex items-center justify-center">
                  <svg className="w-6 h-6 text-text-muted" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                  </svg>
                </div>
              )}
              <div>
                <p className="font-medium text-white">{user.githubUsername}</p>
                <p className="text-sm text-text-muted">Connected via GitHub</p>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 bg-error/10 border border-error/20 rounded-lg">
              <p className="text-error text-sm">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-text-secondary mb-2">
                Email Address
              </label>
              <input
                type="email"
                id="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isSubmitting}
                className="w-full px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-white placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent-cyan/50 focus:border-accent-cyan disabled:opacity-50"
                placeholder="you@example.com"
              />
              <p className="mt-2 text-xs text-text-muted">
                We'll use this email to notify you about important updates and account activity.
              </p>
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !email}
              className="w-full py-4 px-6 bg-accent-cyan hover:bg-accent-cyan/90 rounded-xl text-black font-medium flex items-center justify-center gap-3 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>Saving...</span>
                </>
              ) : (
                <span>Continue</span>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
