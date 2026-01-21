/**
 * TerminalProviderSetup Component
 *
 * Reusable component for terminal-based provider authentication setup.
 * Handles agent spawning, interactive terminal, auth URL detection, and cleanup.
 *
 * Used in:
 * - /providers/setup/[provider] page (full-page setup)
 * - WorkspaceSettingsPanel (embedded setup)
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface ProviderConfig {
  id: string;
  name: string;
  displayName: string;
  color: string;
}

export interface TerminalProviderSetupProps {
  /** Provider configuration */
  provider: ProviderConfig;
  /** Workspace ID to spawn agent in */
  workspaceId: string;
  /** CSRF token for API requests */
  csrfToken?: string;
  /** Maximum height of the terminal */
  maxHeight?: string;
  /** Called when authentication is detected as complete */
  onSuccess?: () => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
  /** Called when cancel is requested */
  onCancel?: () => void;
  /** Called when user wants to connect another provider */
  onConnectAnother?: () => void;
  /** Whether to show header with close button */
  showHeader?: boolean;
  /** Custom class name */
  className?: string;
}

// Terminal theme matching dashboard dark theme
const TERMINAL_THEME = {
  background: '#0d0f14',
  foreground: '#c9d1d9',
  cursor: '#58a6ff',
  cursorAccent: '#0d0f14',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  black: '#484f58',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
};

// Auth URL patterns to detect
const AUTH_URL_PATTERNS = [
  /https:\/\/console\.anthropic\.com\/oauth/i,
  /https:\/\/auth\.openai\.com/i,
  /https:\/\/accounts\.google\.com/i,
  /https:\/\/github\.com\/login\/oauth/i,
  /https:\/\/[^\s]+\/oauth/i,
  /https:\/\/[^\s]+\/auth/i,
  /https:\/\/[^\s]+\/login/i,
];

export function TerminalProviderSetup({
  provider,
  workspaceId,
  csrfToken: initialCsrfToken,
  maxHeight = '400px',
  onSuccess,
  onError,
  onCancel,
  onConnectAnother,
  showHeader = true,
  className = '',
}: TerminalProviderSetupProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shownAuthUrlsRef = useRef<Set<string>>(new Set());
  const hasShownConnectedRef = useRef(false); // Prevent duplicate "Connected" messages
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null); // Track onData handler for cleanup

  const [isSpawning, setIsSpawning] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authModalDismissed, setAuthModalDismissed] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [csrfToken, setCsrfToken] = useState<string | undefined>(initialCsrfToken);

  // Generate unique agent name
  const generateAgentName = useCallback(() => {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `__setup__${provider.id}-${timestamp}${random}`;
  }, [provider.id]);

  // Fetch CSRF token if not provided
  useEffect(() => {
    if (!csrfToken) {
      fetch('/api/auth/session', { credentials: 'include' })
        .then(res => {
          const token = res.headers.get('X-CSRF-Token');
          if (token) setCsrfToken(token);
        })
        .catch(() => {});
    }
  }, [csrfToken]);

  // Cleanup agent
  const cleanupAgent = useCallback(async () => {
    if (!workspaceId || !agentName) return;

    try {
      const headers: Record<string, string> = {};
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      await fetch(`/api/workspaces/${workspaceId}/agents/${encodeURIComponent(agentName)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers,
      });
    } catch {
      // Ignore cleanup errors
    }
  }, [workspaceId, agentName, csrfToken]);

  // Spawn agent
  const spawnAgent = useCallback(async () => {
    if (!workspaceId || !csrfToken) return;

    setIsSpawning(true);
    setError(null);

    const name = generateAgentName();

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const res = await fetch(`/api/workspaces/${workspaceId}/agents`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({
          name,
          provider: provider.id === 'anthropic' ? 'claude' : provider.id,
          interactive: true, // Disable auto-accept prompts
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to spawn agent');
      }

      setAgentName(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to spawn agent';
      setError(message);
      onError?.(message);
    } finally {
      setIsSpawning(false);
    }
  }, [workspaceId, csrfToken, provider.id, generateAgentName, onError]);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      convertEol: true,
      scrollback: 10000,
      cursorBlink: true,
      cursorStyle: 'block',
      disableStdin: false,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Ref to hold authModalDismissed state for use in callbacks without causing re-renders
  const authModalDismissedRef = useRef(authModalDismissed);
  authModalDismissedRef.current = authModalDismissed;

  // Detect auth URLs in output - uses ref to avoid dependency on authModalDismissed
  const detectAuthUrl = useCallback((content: string) => {
    // Don't show modal if user already dismissed it
    if (authModalDismissedRef.current) return false;

    for (const pattern of AUTH_URL_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        // Extract full URL
        const urlMatch = content.match(/https:\/\/[^\s\])"']+/i);
        if (urlMatch) {
          const url = urlMatch[0];
          // Only show modal once per unique URL
          if (!shownAuthUrlsRef.current.has(url)) {
            shownAuthUrlsRef.current.add(url);
            setAuthUrl(url);
            setShowAuthModal(true);
            return true;
          }
        }
      }
    }
    return false;
  }, []); // No dependencies - uses ref for mutable state

  // Connect WebSocket when agent is spawned
  useEffect(() => {
    if (!agentName || !workspaceId) return;

    // Reset the connected message flag when agent changes
    hasShownConnectedRef.current = false;

    const connectWebSocket = () => {
      // Don't reconnect if we already have an open connection
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        return;
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/logs/${encodeURIComponent(workspaceId)}/${encodeURIComponent(agentName)}`;

      setIsConnecting(true);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setIsConnecting(false);
        // Only show connected message once per session
        if (!hasShownConnectedRef.current) {
          hasShownConnectedRef.current = true;
          terminalRef.current?.writeln('\x1b[90m[Connected - Interactive Mode]\x1b[0m');
          terminalRef.current?.writeln('\x1b[90m[Type directly to respond to prompts]\x1b[0m\n');
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsConnecting(false);

        // Reconnect after delay (only if not intentionally closed)
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, 2000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'history' && Array.isArray(data.lines)) {
            data.lines.forEach((line: string) => {
              terminalRef.current?.writeln(line);
              detectAuthUrl(line);
            });
          } else if (data.type === 'log' || data.type === 'output') {
            const content = data.content || data.data || data.message || '';
            if (content) {
              terminalRef.current?.write(content);
              detectAuthUrl(content);
            }
          }
        } catch {
          if (typeof event.data === 'string') {
            terminalRef.current?.write(event.data);
            detectAuthUrl(event.data);
          }
        }
      };

      // Clean up previous onData handler before adding new one
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }

      // Handle user input - store disposable for cleanup
      if (terminalRef.current) {
        onDataDisposableRef.current = terminalRef.current.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', agent: agentName, data }));
          }
        });
      }
    };

    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [agentName, workspaceId, detectAuthUrl]);

  // Auto-spawn on mount
  useEffect(() => {
    if (csrfToken && !agentName && !isSpawning) {
      spawnAgent();
    }
  }, [csrfToken, agentName, isSpawning, spawnAgent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAgent();
    };
  }, [cleanupAgent]);

  const handleOpenAuthUrl = useCallback(() => {
    if (authUrl) {
      window.open(authUrl, '_blank', 'width=600,height=700');
      setShowAuthModal(false); // Close modal after opening URL
    }
  }, [authUrl]);

  const handleComplete = useCallback(async () => {
    // Mark provider as connected in the database
    // Use provider.name (anthropic/openai) not provider.id (claude/codex)
    const providerName = provider.name || provider.id;
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

      const response = await fetch(`/api/onboarding/mark-connected/${providerName}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ workspaceId }),
      });

      if (!response.ok) {
        console.error('Failed to mark provider as connected:', await response.text());
      }
    } catch (err) {
      console.error('Error marking provider as connected:', err);
    }

    await cleanupAgent();
    setIsComplete(true);
  }, [cleanupAgent, provider.id, provider.name, csrfToken, workspaceId]);

  const handleDone = useCallback(() => {
    onSuccess?.();
  }, [onSuccess]);

  const handleConnectAnother = useCallback(() => {
    onConnectAnother?.();
  }, [onConnectAnother]);

  const handleCancel = useCallback(async () => {
    await cleanupAgent();
    onCancel?.();
  }, [cleanupAgent, onCancel]);

  return (
    <div className={`flex flex-col rounded-xl overflow-hidden border border-border-subtle ${className}`}>
      {/* Header */}
      {showHeader && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-bg-tertiary">
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm"
              style={{ backgroundColor: provider.color }}
            >
              {provider.displayName[0]}
            </div>
            <div>
              <h4 className="text-sm font-semibold text-text-primary">
                {provider.displayName} Setup
              </h4>
              <p className="text-xs text-text-muted">Interactive terminal</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isConnected && (
              <span className="flex items-center gap-1 px-2 py-1 rounded-full bg-success/15 text-xs text-success">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                Connected
              </span>
            )}
            {onCancel && (
              <button
                onClick={handleCancel}
                className="p-1.5 rounded-lg hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Success State */}
      {isComplete ? (
        <div className="flex flex-col items-center justify-center py-12 px-6">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
            style={{ backgroundColor: `${provider.color}20` }}
          >
            <CheckIcon className="w-8 h-8" style={{ color: provider.color }} />
          </div>
          <h3 className="text-lg font-semibold text-text-primary mb-2">
            {provider.displayName} Connected!
          </h3>
          <p className="text-sm text-text-muted mb-6 text-center">
            Your {provider.displayName} account has been successfully connected.
          </p>
          <div className="flex gap-3">
            {onConnectAnother && (
              <button
                onClick={handleConnectAnother}
                className="px-4 py-2 bg-bg-hover text-text-primary text-sm font-medium rounded-lg hover:bg-bg-tertiary transition-colors border border-border-subtle"
              >
                Connect Another Provider
              </button>
            )}
            <button
              onClick={handleDone}
              className="px-4 py-2 bg-accent-cyan text-bg-deep text-sm font-semibold rounded-lg hover:bg-accent-cyan/90 transition-colors"
            >
              Continue to Dashboard
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Error */}
          {error && (
            <div className="px-4 py-3 bg-error/10 border-b border-error/30 text-sm text-error flex items-center gap-2">
              <AlertIcon />
              <span>{error}</span>
              <button
                onClick={spawnAgent}
                className="ml-auto text-xs px-2 py-1 rounded bg-error/20 hover:bg-error/30 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* Spawning indicator */}
          {isSpawning && (
            <div className="px-4 py-3 bg-accent-cyan/10 border-b border-accent-cyan/30 text-sm text-accent-cyan flex items-center gap-2">
              <div className="w-4 h-4 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
              <span>Starting {provider.displayName}...</span>
            </div>
          )}

          {/* Terminal */}
          <div
            ref={containerRef}
            className="flex-1 bg-[#0d0f14]"
            style={{ minHeight: '300px', maxHeight }}
            onClick={() => terminalRef.current?.focus()}
          />

          {/* Footer with actions */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle bg-bg-tertiary">
            <p className="text-xs text-text-muted">
              Respond to prompts above to complete setup
            </p>
            <button
              onClick={handleComplete}
              className="px-4 py-2 bg-accent-cyan text-bg-deep text-sm font-semibold rounded-lg hover:bg-accent-cyan/90 transition-colors"
            >
              Done - Continue
            </button>
          </div>
        </>
      )}

      {/* Auth URL Modal */}
      {showAuthModal && authUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-bg-primary border border-border-subtle rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                style={{ backgroundColor: provider.color }}
              >
                {provider.displayName[0]}
              </div>
              <div>
                <h3 className="text-white font-medium">Login URL Detected</h3>
                <p className="text-sm text-text-muted">We found a login link in the terminal</p>
              </div>
            </div>

            <p className="text-sm text-text-muted mb-4">
              {provider.displayName} is asking you to sign in. Click below to open the login page.
            </p>

            <div className="flex gap-3">
              <button
                onClick={handleOpenAuthUrl}
                className="flex-1 py-2 px-4 bg-accent-cyan text-bg-deep font-semibold rounded-lg hover:bg-accent-cyan/90 transition-colors"
              >
                Open Login Page
              </button>
              <button
                onClick={() => {
                  setShowAuthModal(false);
                  setAuthModalDismissed(true);
                }}
                className="px-4 py-2 bg-bg-hover text-text-secondary rounded-lg hover:bg-bg-tertiary transition-colors"
              >
                Dismiss
              </button>
            </div>

            <p className="text-xs text-text-muted mt-3">
              Or copy the URL from the terminal and open it manually.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Icons
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function CheckIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export default TerminalProviderSetup;
