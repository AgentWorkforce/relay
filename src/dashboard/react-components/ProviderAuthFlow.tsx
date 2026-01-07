/**
 * Provider Auth Flow Component
 *
 * Shared component for AI provider OAuth authentication.
 * Used by both the onboarding page and workspace settings.
 *
 * Handles different auth flows:
 * - Claude/Anthropic: OAuth popup → "I've completed login" → poll for credentials
 * - Codex/OpenAI: OAuth popup → copy localhost URL → paste code → submit
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';

export interface ProviderInfo {
  id: string;
  name: string;
  displayName: string;
  color: string;
  cliCommand?: string;
  /** Whether this provider's OAuth redirects to localhost (shows "site can't be reached") */
  requiresUrlCopy?: boolean;
  /** Whether this provider supports device flow */
  supportsDeviceFlow?: boolean;
}

export interface ProviderAuthFlowProps {
  provider: ProviderInfo;
  workspaceId: string;
  csrfToken?: string;
  onSuccess: () => void;
  onCancel: () => void;
  onError: (error: string) => void;
  /** Whether to use device flow (for providers that support it) */
  useDeviceFlow?: boolean;
}

type AuthStatus = 'idle' | 'starting' | 'waiting' | 'submitting' | 'success' | 'error';

// Provider ID mapping for backend
const PROVIDER_ID_MAP: Record<string, string> = {
  codex: 'openai',
};

export function ProviderAuthFlow({
  provider,
  workspaceId,
  csrfToken,
  onSuccess,
  onCancel,
  onError,
  useDeviceFlow = false,
}: ProviderAuthFlowProps) {
  const [status, setStatus] = useState<AuthStatus>('idle');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cliCommand, setCliCommand] = useState<string | null>(null);
  const [cliWorkspaceId, setCliWorkspaceId] = useState<string | null>(null);
  const [cliWorkspaceName, setCliWorkspaceName] = useState<string | null>(null);
  const [cliCommandLoading, setCliCommandLoading] = useState(false);
  const [showManualFallback, setShowManualFallback] = useState(false);
  const [cliPollingActive, setCliPollingActive] = useState(false);
  const [isDeviceFlow, setIsDeviceFlow] = useState(false);
  const popupOpenedRef = useRef(false);
  const pollingRef = useRef(false);
  const cliPollingRef = useRef(false);

  const backendProviderId = PROVIDER_ID_MAP[provider.id] || provider.id;

  // Determine if this is the Codex flow (needs to be defined early for use in startAuth)
  const isCodexFlow = provider.requiresUrlCopy || provider.id === 'codex' || backendProviderId === 'openai';

  // Start the OAuth flow
  const startAuth = useCallback(async () => {
    setStatus('starting');
    setErrorMessage(null);
    popupOpenedRef.current = false;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/onboarding/cli/${backendProviderId}/start`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ workspaceId, useDeviceFlow }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to start authentication');
      }

      if (data.status === 'success' || data.alreadyAuthenticated) {
        setStatus('success');
        onSuccess();
        return;
      }

      setSessionId(data.sessionId);

      // Track if device flow is being used (from API response)
      if (data.useDeviceFlow) {
        setIsDeviceFlow(true);
      }

      if (data.authUrl) {
        setAuthUrl(data.authUrl);
        setStatus('waiting');
        // For Codex flow with device auth, can auto-open popup since no localhost callback needed
        // For standard Codex flow, wait for user to confirm local server is running
        if (!isCodexFlow || data.useDeviceFlow) {
          openAuthPopup(data.authUrl);
        }
        startPolling(data.sessionId);
      } else if (data.sessionId) {
        // No URL yet, poll for it
        startPolling(data.sessionId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start authentication';
      setErrorMessage(msg);
      setStatus('error');
      onError(msg);
    }
  }, [backendProviderId, workspaceId, csrfToken, useDeviceFlow, onSuccess, onError, isCodexFlow]);

  // Ref to hold the latest code submission handler (avoids stale closure in polling)
  const handleCodeReceivedRef = useRef<((code: string, state?: string) => Promise<void>) | null>(null);

  // Ref to hold handleComplete (avoids circular dependency with startCliPolling)
  const handleCompleteRef = useRef<((sid?: string) => Promise<void>) | null>(null);

  // Poll for CLI auth completion via SSH tunnel (must be defined before fetchCliSession)
  // This polls the workspace directly to check if Codex is authenticated
  const startCliPolling = useCallback((cliAuthWorkspaceId: string, sid?: string) => {
    if (cliPollingRef.current) return;
    cliPollingRef.current = true;
    setCliPollingActive(true);

    const maxAttempts = 120; // 10 minutes at 5s intervals
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts || !cliPollingRef.current) {
        cliPollingRef.current = false;
        setCliPollingActive(false);
        return;
      }

      try {
        // Poll workspace auth status (via SSH tunnel approach)
        const res = await fetch(`/api/auth/codex-helper/auth-status/${cliAuthWorkspaceId}`, {
          credentials: 'include',
        });

        if (res.ok) {
          const data = await res.json() as { authenticated: boolean };

          if (data.authenticated) {
            cliPollingRef.current = false;
            setCliPollingActive(false);
            // Auth completed via SSH tunnel, now complete the flow to store credentials
            // Use the session ID from the main auth flow (via ref to avoid stale closure)
            if (handleCompleteRef.current) {
              await handleCompleteRef.current(sid);
            }
            return;
          }
        }

        attempts++;
        setTimeout(poll, 5000);
      } catch (err) {
        console.error('CLI poll error:', err);
        attempts++;
        setTimeout(poll, 5000);
      }
    };

    poll();
  }, []);

  // Fetch CLI session for Codex - provides a command the user can run locally
  // For workspace-based flow, returns SSH tunnel command
  const fetchCliSession = useCallback(async () => {
    if (!isCodexFlow) return;

    setCliCommandLoading(true);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch('/api/auth/codex-helper/cli-session', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          workspaceId,
          authUrl, // Pass authUrl so CLI can use it directly without needing session auth
          sessionId, // Pass sessionId for credential storage
        }),
      });

      if (res.ok) {
        const data = await res.json() as {
          workspaceId?: string;
          workspaceName?: string;
          command: string;
          commandWithUrl?: string;
          // Legacy fields
          authSessionId?: string;
        };

        // Prefer commandWithUrl if available (includes cloud URL)
        setCliCommand(data.commandWithUrl || data.command);

        if (data.workspaceId) {
          // New SSH tunnel flow
          setCliWorkspaceId(data.workspaceId);
          setCliWorkspaceName(data.workspaceName || null);
          // Start polling workspace auth status, passing session ID for completion
          startCliPolling(data.workspaceId, sessionId || undefined);
        } else if (data.authSessionId) {
          // Legacy token-based flow (backwards compatibility)
          setCliWorkspaceId(data.authSessionId);
          startCliPolling(data.authSessionId, sessionId || undefined);
        }
      }
    } catch (err) {
      console.error('Failed to fetch CLI session:', err);
    } finally {
      setCliCommandLoading(false);
    }
  }, [isCodexFlow, workspaceId, csrfToken, startCliPolling, sessionId, authUrl]);

  // Fetch CLI session when auth starts for Codex (only for standard flow, not device flow)
  useEffect(() => {
    if (status === 'waiting' && isCodexFlow && !isDeviceFlow && !cliCommand) {
      fetchCliSession();
    }
  }, [status, isCodexFlow, isDeviceFlow, cliCommand, fetchCliSession]);

  // Open OAuth popup
  const openAuthPopup = useCallback((url: string) => {
    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    window.open(
      url,
      `${provider.displayName} Login`,
      `width=${width},height=${height},left=${left},top=${top},popup=yes`
    );
    popupOpenedRef.current = true;
  }, [provider.displayName]);

  // Poll for auth status
  const startPolling = useCallback((sid: string) => {
    if (pollingRef.current) return;
    pollingRef.current = true;

    const maxAttempts = 60;
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        pollingRef.current = false;
        setErrorMessage('Authentication timed out. Please try again.');
        setStatus('error');
        onError('Authentication timed out');
        return;
      }

      try {
        const res = await fetch(`/api/onboarding/cli/${backendProviderId}/status/${sid}`, {
          credentials: 'include',
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Failed to check status');
        }

        if (data.status === 'success') {
          pollingRef.current = false;
          await handleComplete(sid);
          return;
        } else if (data.status === 'error') {
          throw new Error(data.error || 'Authentication failed');
        } else if (data.status === 'waiting_auth' && data.authUrl) {
          setAuthUrl(data.authUrl);
          setStatus('waiting');
          // For Codex flow, don't auto-open popup - wait for user confirmation
          if (!popupOpenedRef.current && !isCodexFlow) {
            openAuthPopup(data.authUrl);
          }
        }

        attempts++;
        setTimeout(poll, 5000);
      } catch (err) {
        pollingRef.current = false;
        const msg = err instanceof Error ? err.message : 'Auth check failed';
        setErrorMessage(msg);
        setStatus('error');
        onError(msg);
      }
    };

    poll();
  }, [backendProviderId, openAuthPopup, onError, isCodexFlow]);

  // Complete auth by polling for credentials
  const handleComplete = useCallback(async (sid?: string) => {
    const targetSessionId = sid || sessionId;
    if (!targetSessionId) return;

    setStatus('submitting');
    setErrorMessage(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/onboarding/cli/${backendProviderId}/complete/${targetSessionId}`, {
        method: 'POST',
        credentials: 'include',
        headers,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to complete authentication');
      }

      setStatus('success');
      // Brief delay to show success message before parent unmounts component
      setTimeout(() => onSuccess(), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to complete authentication';
      setErrorMessage(msg);
      setStatus('error');
      onError(msg);
    }
  }, [sessionId, backendProviderId, csrfToken, onSuccess, onError]);

  // Keep handleCompleteRef in sync (for CLI polling to avoid stale closure)
  useEffect(() => {
    handleCompleteRef.current = handleComplete;
  }, [handleComplete]);

  // Submit auth code (for providers like Codex that need it)
  const handleSubmitCode = useCallback(async () => {
    if (!sessionId || !codeInput.trim()) return;

    setStatus('submitting');
    setErrorMessage(null);

    // Extract code from URL if user pasted the full callback URL
    let code = codeInput.trim();
    if (code.includes('code=')) {
      try {
        const url = new URL(code);
        const extractedCode = url.searchParams.get('code');
        if (extractedCode) {
          code = extractedCode;
        }
      } catch {
        const match = code.match(/code=([^&\s]+)/);
        if (match) {
          code = match[1];
        }
      }
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/onboarding/cli/${backendProviderId}/code/${sessionId}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ code }),
      });

      const data = await res.json() as { success?: boolean; status?: string; error?: string; needsRestart?: boolean };

      if (!res.ok) {
        // If server indicates we need to restart, show helpful message
        if (data.needsRestart) {
          setErrorMessage('The authentication session timed out. Please click "Try Again" to restart.');
          setStatus('error');
          return;
        }
        throw new Error(data.error || 'Failed to submit auth code');
      }

      setCodeInput('');

      // Backend returns { success: true } not { status: 'success' }
      if (data.success) {
        // Code was accepted, now complete the auth flow to store credentials
        await handleComplete();
      }
      // Otherwise continue polling
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to submit auth code';
      setErrorMessage(msg);
      setStatus('error');
      onError(msg);
    }
  }, [sessionId, codeInput, backendProviderId, csrfToken, handleComplete, onError]);

  // Update the ref for CLI polling to use (avoids stale closure)
  useEffect(() => {
    handleCodeReceivedRef.current = async (code: string, state?: string) => {
      if (!sessionId) return;

      setStatus('submitting');
      setErrorMessage(null);

      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

        const res = await fetch(`/api/onboarding/cli/${backendProviderId}/code/${sessionId}`, {
          method: 'POST',
          credentials: 'include',
          headers,
          body: JSON.stringify({ code, state }), // Include state for CSRF validation
        });

        const data = await res.json() as { success?: boolean; error?: string; needsRestart?: boolean };

        if (!res.ok) {
          if (data.needsRestart) {
            setErrorMessage('The authentication session timed out. Please click "Try Again" to restart.');
            setStatus('error');
            return;
          }
          throw new Error(data.error || 'Failed to submit auth code');
        }

        if (data.success) {
          await handleComplete();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to submit auth code';
        setErrorMessage(msg);
        setStatus('error');
        onError(msg);
      }
    };
  }, [sessionId, backendProviderId, csrfToken, handleComplete, onError]);

  // Cancel auth flow
  const handleCancel = useCallback(async () => {
    pollingRef.current = false;

    if (sessionId) {
      try {
        await fetch(`/api/onboarding/cli/${backendProviderId}/cancel/${sessionId}`, {
          method: 'POST',
          credentials: 'include',
        });
      } catch {
        // Ignore cancel errors
      }
    }

    setStatus('idle');
    setAuthUrl(null);
    setSessionId(null);
    setCodeInput('');
    setErrorMessage(null);
    onCancel();
  }, [sessionId, backendProviderId, onCancel]);

  // Start auth when component mounts (parent controls when to render this component)
  useEffect(() => {
    if (status === 'idle') {
      startAuth();
    }
    // Cleanup on unmount
    return () => {
      pollingRef.current = false;
      cliPollingRef.current = false;
      setCliPollingActive(false);
    };
  }, [startAuth, status]);

  // Determine if this is Claude flow (isCodexFlow defined earlier)
  const isClaudeFlow = provider.id === 'anthropic' || backendProviderId === 'anthropic';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
          style={{ backgroundColor: provider.color }}
        >
          {provider.displayName[0]}
        </div>
        <div>
          <h3 className="font-medium text-white">{provider.displayName}</h3>
          <p className="text-sm text-text-muted">
            {status === 'starting' && 'Starting authentication...'}
            {status === 'waiting' && 'Complete authentication below'}
            {status === 'submitting' && 'Verifying...'}
            {status === 'success' && 'Connected!'}
            {status === 'error' && (errorMessage || 'Authentication failed')}
          </p>
        </div>
      </div>

      {/* Starting state */}
      {status === 'starting' && (
        <div className="flex items-center justify-center gap-3 py-4">
          <svg className="w-5 h-5 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-text-muted">Preparing authentication...</span>
        </div>
      )}

      {/* Waiting state */}
      {status === 'waiting' && authUrl && (
        <div className="space-y-4">
          {/* Instructions - different for each provider */}
          <div className="p-4 bg-bg-tertiary rounded-lg border border-border-subtle">
            <h4 className="font-medium text-white mb-2">Complete authentication:</h4>
            {isCodexFlow && isDeviceFlow ? (
              /* Codex/OpenAI with device flow: Simple browser-based auth */
              <p className="text-sm text-text-muted">
                Sign in with your OpenAI account in the popup window. You&apos;ll see a device code to enter - this confirms the authorization.
              </p>
            ) : isCodexFlow ? (
              /* Codex/OpenAI standard flow: SSH tunnel forwards OAuth callback to workspace */
              <p className="text-sm text-text-muted">
                Run the CLI command below. It establishes an SSH tunnel to forward the OAuth callback to your workspace.
              </p>
            ) : isClaudeFlow ? (
              /* Claude/Anthropic: Shows a code after OAuth completion */
              <ol className="text-sm text-text-muted space-y-2 list-decimal list-inside">
                <li>Click the button below to open the login page</li>
                <li>Sign in with your Anthropic account</li>
                <li>After signing in, Anthropic will display an <strong>authentication code</strong></li>
                <li>Copy that code and paste it in the input below</li>
                <li>Click Submit to complete authentication</li>
              </ol>
            ) : (
              /* Other providers: Try polling for credentials first */
              <ol className="text-sm text-text-muted space-y-2 list-decimal list-inside">
                <li>Click the button below to open the login page</li>
                <li>Sign in with your {provider.displayName} account</li>
                <li>If you receive a code, paste it below. Otherwise click &quot;I&apos;ve completed login&quot;</li>
              </ol>
            )}
          </div>

          {/* Auth URL button - hidden for Codex CLI flow since it's integrated into steps */}
          {!(isCodexFlow && cliCommand && !showManualFallback) && (
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full py-2 px-4 bg-bg-tertiary border border-border-subtle text-white font-medium rounded-lg text-center hover:border-accent-cyan/50 transition-all"
            >
              Open {provider.displayName} Login Page
            </a>
          )}

          {isCodexFlow && isDeviceFlow ? (
            /* Codex with Device Flow: Simple browser-based auth, no CLI helper needed */
            <div className="space-y-4">
              <div className="p-3 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg">
                <p className="text-sm text-accent-cyan">
                  <strong>Device Authentication:</strong> Complete the sign-in in the popup window.
                  After signing in, you&apos;ll see a code - enter it on the OpenAI page to authorize.
                </p>
              </div>
              <div className="flex items-center gap-2 p-3 bg-accent-cyan/5 border border-accent-cyan/20 rounded-lg text-sm text-accent-cyan">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>Waiting for authentication to complete...</span>
              </div>
              <button
                onClick={() => handleComplete()}
                className="w-full py-2 text-text-muted hover:text-white transition-colors text-sm"
              >
                I&apos;ve completed authentication
              </button>
            </div>
          ) : isCodexFlow ? (
            /* Codex standard flow: CLI helper or manual URL paste */
            <div className="space-y-4">
              {/* Loading state while fetching CLI command */}
              {cliCommandLoading && (
                <div className="flex items-center gap-3 p-4 bg-bg-tertiary rounded-lg border border-border-subtle">
                  <svg className="w-5 h-5 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm text-text-muted">Generating session token...</span>
                </div>
              )}

              {/* Primary: CLI command - shown BEFORE the login button */}
              {cliCommand && !showManualFallback && !cliCommandLoading && (
                <div className="space-y-3">
                  {/* Step 1: Copy and run the command */}
                  <div className="p-3 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg">
                    <p className="text-sm text-accent-cyan mb-2">
                      <strong>Step 1:</strong> Copy and run this command in your terminal
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 px-3 py-2 bg-bg-deep rounded-lg text-xs font-mono text-white overflow-x-auto">
                        {cliCommand}
                      </code>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(cliCommand);
                        }}
                        className="px-3 py-2 bg-bg-tertiary border border-border-subtle rounded-lg text-text-muted hover:text-white hover:border-accent-cyan/50 transition-colors text-xs"
                      >
                        Copy
                      </button>
                    </div>
                  </div>

                  {/* Step 2: Sign in */}
                  <div className="p-3 bg-bg-tertiary border border-border-subtle rounded-lg">
                    <p className="text-sm text-white mb-1">
                      <strong>Step 2:</strong> Sign in with OpenAI
                    </p>
                    <p className="text-xs text-text-muted">
                      The CLI will open your browser to the OpenAI login page. Sign in with your OpenAI account.
                    </p>
                  </div>

                  {/* Step 3: Wait for completion */}
                  <div className="p-3 bg-bg-tertiary border border-border-subtle rounded-lg">
                    <p className="text-sm text-white mb-1">
                      <strong>Step 3:</strong> Authentication completes automatically
                    </p>
                    <p className="text-xs text-text-muted">
                      After signing in, the CLI will capture the callback and this page will update automatically.
                    </p>
                  </div>

                  {cliPollingActive && (
                    <div className="flex items-center gap-2 p-3 bg-success/10 border border-success/30 rounded-lg text-sm text-success">
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      <span>Waiting for authentication to complete...</span>
                    </div>
                  )}

                  <button
                    onClick={() => setShowManualFallback(true)}
                    className="text-xs text-text-muted hover:text-white transition-colors"
                  >
                    CLI not working? Click here for manual method
                  </button>
                </div>
              )}

              {/* Fallback: Manual URL paste - only show when not loading */}
              {!cliCommandLoading && (showManualFallback || !cliCommand) && (
                <div className="space-y-3">
                  <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                    <p className="text-xs text-amber-400">
                      <strong>Manual method:</strong> After login, you&apos;ll see &quot;This site can&apos;t be reached&quot; - this is expected!
                      Copy the full URL from your browser&apos;s address bar and paste it below.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Paste the localhost URL here (e.g., http://localhost:...)"
                      value={codeInput}
                      onChange={(e) => setCodeInput(e.target.value)}
                      className="flex-1 px-4 py-3 bg-bg-tertiary border border-border-subtle rounded-xl text-white placeholder-text-muted focus:outline-none focus:border-accent-cyan transition-colors font-mono text-sm"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && codeInput.trim()) {
                          handleSubmitCode();
                        }
                      }}
                    />
                    <button
                      onClick={handleSubmitCode}
                      disabled={!codeInput.trim()}
                      className="px-6 py-3 bg-accent-cyan text-bg-deep font-semibold rounded-xl hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      Submit
                    </button>
                  </div>
                  {cliCommand && (
                    <button
                      onClick={() => setShowManualFallback(false)}
                      className="text-xs text-accent-cyan hover:underline"
                    >
                      ← Back to CLI method
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : isClaudeFlow ? (
            /* Claude: Code paste flow */
            <div className="space-y-3">
              <div className="p-3 bg-accent-cyan/10 border border-accent-cyan/30 rounded-lg">
                <p className="text-xs text-accent-cyan">
                  <strong>Look for the code:</strong> After signing in, Anthropic will show you an authentication code.
                  Copy it and paste it below.
                </p>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Paste the authentication code here"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  className="flex-1 px-4 py-3 bg-bg-tertiary border border-border-subtle rounded-xl text-white placeholder-text-muted focus:outline-none focus:border-accent-cyan transition-colors font-mono text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && codeInput.trim()) {
                      handleSubmitCode();
                    }
                  }}
                />
                <button
                  onClick={handleSubmitCode}
                  disabled={!codeInput.trim()}
                  className="px-6 py-3 bg-accent-cyan text-bg-deep font-semibold rounded-xl hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  Submit
                </button>
              </div>
            </div>
          ) : (
            /* Other providers: Code input with fallback button */
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Paste authentication code (if provided)"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  className="flex-1 px-4 py-3 bg-bg-tertiary border border-border-subtle rounded-xl text-white placeholder-text-muted focus:outline-none focus:border-accent-cyan transition-colors font-mono text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && codeInput.trim()) {
                      handleSubmitCode();
                    }
                  }}
                />
                <button
                  onClick={handleSubmitCode}
                  disabled={!codeInput.trim()}
                  className="px-6 py-3 bg-accent-cyan text-bg-deep font-semibold rounded-xl hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  Submit
                </button>
              </div>
              <button
                onClick={() => handleComplete()}
                className="w-full py-2 text-text-muted hover:text-white transition-colors text-sm"
              >
                No code? Click here if you&apos;ve completed login
              </button>
            </div>
          )}

          {/* Cancel button */}
          <button
            onClick={handleCancel}
            className="w-full py-2 text-text-muted hover:text-white transition-colors text-sm"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Submitting state */}
      {status === 'submitting' && (
        <div className="flex items-center justify-center gap-3 py-4">
          <svg className="w-5 h-5 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-text-muted">Verifying authentication...</span>
        </div>
      )}

      {/* Success state */}
      {status === 'success' && (
        <div className="flex items-center justify-center gap-3 py-4">
          <div className="w-10 h-10 bg-success/20 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <span className="text-white font-medium">{provider.displayName} connected!</span>
        </div>
      )}

      {/* Error state */}
      {status === 'error' && (
        <div className="space-y-3">
          <div className="p-4 bg-error/10 border border-error/30 rounded-lg text-error text-sm">
            {errorMessage || 'Authentication failed. Please try again.'}
          </div>
          <div className="flex gap-3">
            <button
              onClick={startAuth}
              className="flex-1 py-2 px-4 bg-bg-tertiary border border-border-subtle text-white rounded-lg hover:border-accent-cyan/50 transition-colors"
            >
              Try Again
            </button>
            <button
              onClick={handleCancel}
              className="py-2 px-4 text-text-muted hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
