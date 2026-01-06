/**
 * Provider Setup Client Component
 *
 * Interactive terminal for provider authentication and setup.
 * Shows real-time Claude/Codex initialization with auth URL detection.
 */

'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LogoIcon } from '../../../../react-components/Logo';

import { PROVIDER_CONFIGS } from './constants';

// Auth URL patterns to detect and open in popup
const AUTH_URL_PATTERNS = [
  // Anthropic/Claude
  /https:\/\/console\.anthropic\.com\/[^\s"'<>]+/,
  // OpenAI
  /https:\/\/auth0\.openai\.com\/[^\s"'<>]+/,
  /https:\/\/platform\.openai\.com\/[^\s"'<>]+/,
  // Generic OAuth localhost callbacks
  /http:\/\/localhost:\d+\/[^\s"'<>]*/,
  /http:\/\/127\.0\.0\.1:\d+\/[^\s"'<>]*/,
];

export interface ProviderSetupClientProps {
  provider: string;
}

export function ProviderSetupClient({ provider }: ProviderSetupClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get('workspace');

  const config = PROVIDER_CONFIGS[provider];

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [agentName, setAgentName] = useState<string | null>(null);
  const detectedUrlsRef = useRef<Set<string>>(new Set());

  // Spawn a temporary setup agent
  useEffect(() => {
    if (!workspaceId || !config) return;

    const spawnSetupAgent = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Create a temporary agent name for setup
        const setupAgentName = `setup-${config.id}-${Date.now()}`;
        setAgentName(setupAgentName);

        const res = await fetch(`/api/workspaces/${workspaceId}/agents`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: setupAgentName,
            provider: config.id,
            task: 'Authentication setup - please complete the login flow',
            temporary: true,
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to start setup');
        }

        setIsLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start setup');
        setIsLoading(false);
      }
    };

    spawnSetupAgent();
  }, [workspaceId, config]);

  // Monitor terminal output for auth URLs
  const handleTerminalOutput = useCallback((output: string) => {
    for (const pattern of AUTH_URL_PATTERNS) {
      const match = output.match(pattern);
      if (match && match[0]) {
        const url = match[0];
        // Only trigger once per unique URL
        if (!detectedUrlsRef.current.has(url)) {
          detectedUrlsRef.current.add(url);
          setAuthUrl(url);
          setShowAuthModal(true);
        }
      }
    }

    // Check for success patterns
    if (
      output.includes('Successfully authenticated') ||
      output.includes('Authentication successful') ||
      output.includes('Logged in as') ||
      output.includes('Welcome,')
    ) {
      setIsConnected(true);
    }
  }, []);

  // Open auth URL in popup
  const openAuthPopup = useCallback(() => {
    if (!authUrl) return;

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    window.open(
      authUrl,
      `${config?.displayName || 'Provider'} Login`,
      `width=${width},height=${height},left=${left},top=${top},popup=yes`
    );
  }, [authUrl, config?.displayName]);

  // Handle completion
  const handleComplete = useCallback(() => {
    router.push(`/app?workspace=${workspaceId}`);
  }, [router, workspaceId]);

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0f] via-[#0d1117] to-[#0a0a0f] flex flex-col">
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

      {/* Header */}
      <div className="relative z-10 flex items-center justify-between p-4 border-b border-border-subtle">
        <div className="flex items-center gap-3">
          <LogoIcon size={32} withGlow={false} />
          <div className="w-px h-6 bg-border-subtle" />
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm"
              style={{ backgroundColor: config.color }}
            >
              {config.displayName[0]}
            </div>
            <span className="text-white font-medium">{config.displayName} Setup</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isConnected ? (
            <button
              onClick={handleComplete}
              className="px-4 py-2 bg-success/20 text-success font-medium rounded-lg hover:bg-success/30 transition-colors"
            >
              Continue to Dashboard
            </button>
          ) : (
            <button
              onClick={() => router.push('/app')}
              className="px-4 py-2 text-text-muted hover:text-white transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex flex-col p-4 gap-4">
        {/* Status bar */}
        <div className="flex items-center gap-3 p-3 bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-xl">
          {isLoading ? (
            <>
              <svg className="w-5 h-5 text-accent-cyan animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-text-muted">Starting {config.displayName}...</span>
            </>
          ) : isConnected ? (
            <>
              <div className="w-5 h-5 bg-success/20 rounded-full flex items-center justify-center">
                <svg className="w-3 h-3 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <span className="text-success font-medium">{config.displayName} connected!</span>
            </>
          ) : error ? (
            <>
              <div className="w-5 h-5 bg-error/20 rounded-full flex items-center justify-center">
                <span className="text-error font-bold text-xs">!</span>
              </div>
              <span className="text-error">{error}</span>
            </>
          ) : (
            <>
              <div className="w-2 h-2 bg-accent-cyan rounded-full animate-pulse" />
              <span className="text-text-muted">
                Waiting for authentication - complete the login in the terminal below
              </span>
            </>
          )}
        </div>

        {/* Interactive terminal */}
        <div className="flex-1 min-h-[400px]">
          {agentName && (
            <XTermInteractiveWithOutputHook
              agentName={agentName}
              onOutput={handleTerminalOutput}
              maxHeight="100%"
            />
          )}
        </div>

        {/* Help text */}
        <div className="p-4 bg-bg-primary/80 backdrop-blur-sm border border-border-subtle rounded-xl">
          <h3 className="text-white font-medium mb-2">How this works:</h3>
          <ol className="text-sm text-text-muted space-y-1 list-decimal list-inside">
            <li>The terminal above shows {config.displayName} starting up</li>
            <li>When it needs authentication, a login popup will open automatically</li>
            <li>Complete the login in the popup window</li>
            <li>If prompted about skills or permissions, respond directly in the terminal</li>
            <li>Once connected, click &quot;Continue to Dashboard&quot;</li>
          </ol>
        </div>
      </div>

      {/* Auth URL Modal */}
      {showAuthModal && authUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-bg-primary border border-border-subtle rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold"
                style={{ backgroundColor: config.color }}
              >
                {config.displayName[0]}
              </div>
              <div>
                <h3 className="text-white font-medium">Authentication Required</h3>
                <p className="text-sm text-text-muted">Sign in to continue</p>
              </div>
            </div>

            <p className="text-sm text-text-muted mb-4">
              {config.displayName} needs you to sign in. Click the button below to open the login page.
            </p>

            <div className="space-y-3">
              <button
                onClick={openAuthPopup}
                className="w-full py-3 px-4 bg-gradient-to-r from-accent-cyan to-[#00b8d9] text-bg-deep font-semibold rounded-xl hover:shadow-glow-cyan transition-all"
              >
                Open Login Page
              </button>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(authUrl);
                  }}
                  className="flex-1 py-2 px-4 bg-bg-tertiary border border-border-subtle text-text-muted rounded-lg hover:text-white hover:border-accent-cyan/50 transition-colors text-sm"
                >
                  Copy URL
                </button>
                <button
                  onClick={() => setShowAuthModal(false)}
                  className="flex-1 py-2 px-4 text-text-muted hover:text-white transition-colors text-sm"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Wrapper for XTermInteractive that hooks into output for URL detection
 */
function XTermInteractiveWithOutputHook({
  agentName,
  onOutput,
  maxHeight,
}: {
  agentName: string;
  onOutput: (output: string) => void;
  maxHeight?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  // Dynamically import xterm to avoid SSR issues
  useEffect(() => {
    let mounted = true;

    const initTerminal = async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      if (!mounted || !containerRef.current) return;

      const terminal = new Terminal({
        theme: {
          background: '#0d0f14',
          foreground: '#c9d1d9',
          cursor: '#58a6ff',
          cursorAccent: '#0d0f14',
          selectionBackground: '#264f78',
          black: '#484f58',
          red: '#f85149',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#39c5cf',
          white: '#b1bac4',
        },
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.4,
        convertEol: true,
        scrollback: 10000,
        cursorBlink: true,
        cursorStyle: 'block',
        disableStdin: false,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Handle user input
      terminal.onData((data: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'input', agent: agentName, data }));
        }
      });

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
      });
      resizeObserver.observe(containerRef.current);

      // Connect to WebSocket
      connectWebSocket();

      return () => {
        resizeObserver.disconnect();
        terminal.dispose();
      };
    };

    const connectWebSocket = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/logs/${encodeURIComponent(agentName)}`;

      setIsConnecting(true);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setIsConnecting(false);
        terminalRef.current?.writeln('\x1b[90m[Connected - Interactive Mode]\x1b[0m\n');
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsConnecting(false);

        // Reconnect after delay
        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, 2000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'history' && Array.isArray(data.lines)) {
            data.lines.forEach((line: string) => {
              terminalRef.current?.writeln(line);
              onOutput(line);
            });
          } else if (data.type === 'log' || data.type === 'output') {
            const content = data.content || data.data || data.message || '';
            if (content) {
              terminalRef.current?.write(content);
              onOutput(content);
            }
          }
        } catch {
          if (typeof event.data === 'string') {
            terminalRef.current?.write(event.data);
            onOutput(event.data);
          }
        }
      };
    };

    initTerminal();

    return () => {
      mounted = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [agentName, onOutput]);

  return (
    <div
      className="flex flex-col rounded-xl overflow-hidden border border-[#2a2d35] shadow-2xl h-full"
      style={{
        background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)',
        maxHeight,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-[#21262d]"
        style={{ background: 'linear-gradient(180deg, #161b22 0%, #0d1117 100%)' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-[#ff5f56] border border-[#e0443e]" />
            <div className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-[#dea123]" />
            <div className="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29]" />
          </div>
          <div className="w-px h-4 bg-[#30363d]" />
          <span className="text-sm font-semibold text-accent-cyan">{agentName}</span>
          <span className="px-1.5 py-0.5 rounded-full bg-accent-purple/20 text-[10px] text-accent-purple uppercase tracking-wider">
            Interactive
          </span>
          {isConnected ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#238636]/20 text-[10px] text-[#3fb950] uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-[#3fb950]" />
              live
            </span>
          ) : isConnecting ? (
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#d29922]/20 text-[10px] text-[#d29922] uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-[#d29922] animate-pulse" />
              connecting
            </span>
          ) : null}
        </div>
      </div>

      {/* Terminal */}
      <div ref={containerRef} className="flex-1 overflow-hidden min-h-[300px]" />

      {/* Footer */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-t border-[#21262d] text-xs"
        style={{ background: 'linear-gradient(180deg, #0d1117 0%, #0a0c10 100%)' }}
      >
        <span className="text-[#6e7681]">Type directly to interact</span>
        <div className="flex items-center gap-2">
          <span className="text-[#6e7681] font-mono uppercase tracking-wider text-[10px]">
            Interactive PTY
          </span>
          <div
            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#3fb950]' : 'bg-[#484f58]'}`}
            style={{ boxShadow: isConnected ? '0 0 8px rgba(63,185,80,0.6)' : 'none' }}
          />
        </div>
      </div>
    </div>
  );
}
