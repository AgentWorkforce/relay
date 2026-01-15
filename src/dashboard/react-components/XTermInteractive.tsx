/**
 * XTermInteractive Component
 *
 * Interactive terminal using xterm.js that allows user input.
 * Used for direct terminal access to agents during setup, debugging,
 * or when prompts require user interaction (skill loading, auth flows, etc.)
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getAgentColor } from '../lib/colors';
import { useWorkspaceWsUrl } from './WorkspaceContext';

export interface XTermInteractiveProps {
  /** Agent name to connect to */
  agentName: string;
  /** Maximum height of the terminal */
  maxHeight?: string;
  /** Whether to show the header bar */
  showHeader?: boolean;
  /** Callback when close button is clicked */
  onClose?: () => void;
  /** Custom class name */
  className?: string;
}

// Theme matching the dashboard dark theme
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

export function XTermInteractive({
  agentName,
  maxHeight = '500px',
  showHeader = true,
  onClose,
  className = '',
}: XTermInteractiveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const hasShownConnectedRef = useRef(false); // Prevent duplicate "Connected" messages

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const colors = getAgentColor(agentName);

  // Get WebSocket URL from workspace context (handles cloud vs local mode)
  const logStreamUrl = useWorkspaceWsUrl(`/ws/logs/${encodeURIComponent(agentName)}`);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current) return;

    // Reset connected message flag when agent changes
    hasShownConnectedRef.current = false;

    const terminal = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      convertEol: true,
      scrollback: 10000,
      cursorBlink: true,
      cursorStyle: 'block',
      disableStdin: false, // Enable input!
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle user input - send to WebSocket
    terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'input',
          agent: agentName,
          data,
        }));
      }
    });

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
  }, [agentName]);

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN ||
        wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    setIsConnecting(true);
    setError(null);

    const ws = new WebSocket(logStreamUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setIsConnecting(false);
      setError(null);
      reconnectAttemptsRef.current = 0;

      // Only show connected message once per session
      if (!hasShownConnectedRef.current) {
        hasShownConnectedRef.current = true;
        terminalRef.current?.writeln(`\x1b[90m[Connected to ${agentName} - Interactive Mode]\x1b[0m`);
        terminalRef.current?.writeln(`\x1b[90m[You can type directly in this terminal]\x1b[0m\n`);
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);
      setIsConnecting(false);
      wsRef.current = null;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      // Don't reconnect for agent not found
      if (event.code === 4404) {
        terminalRef.current?.writeln(`\x1b[31m[Agent not found]\x1b[0m`);
        return;
      }

      // Schedule reconnect
      const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
      reconnectAttemptsRef.current++;

      terminalRef.current?.writeln(`\x1b[90m[Disconnected. Reconnecting in ${delay / 1000}s...]\x1b[0m`);

      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    ws.onerror = () => {
      setError(new Error('WebSocket connection error'));
      setIsConnecting(false);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Handle different message types
        if (data.type === 'error') {
          terminalRef.current?.writeln(`\x1b[31mError: ${data.error}\x1b[0m`);
          return;
        }

        if (data.type === 'subscribed') {
          return;
        }

        // Handle history (initial log dump)
        if (data.type === 'history' && Array.isArray(data.lines)) {
          data.lines.forEach((line: string) => {
            terminalRef.current?.writeln(line);
          });
          return;
        }

        // Handle live output
        if (data.type === 'log' || data.type === 'output') {
          const content = data.content || data.data || data.message || '';
          if (content) {
            // Write raw content - xterm.js handles ANSI codes natively
            terminalRef.current?.write(content);
          }
          return;
        }

        // Handle batch of lines
        if (data.lines && Array.isArray(data.lines)) {
          data.lines.forEach((line: string | { content: string }) => {
            const content = typeof line === 'string' ? line : line.content;
            terminalRef.current?.writeln(content);
          });
        }
      } catch {
        // Plain text message
        if (typeof event.data === 'string') {
          terminalRef.current?.write(event.data);
        }
      }
    };
  }, [logStreamUrl, agentName]);

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
    setIsConnecting(false);
  }, []);

  // Clear terminal
  const clear = useCallback(() => {
    terminalRef.current?.clear();
  }, []);

  // Focus terminal
  const focus = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  // Focus terminal when connected
  useEffect(() => {
    if (isConnected) {
      setTimeout(() => focus(), 100);
    }
  }, [isConnected, focus]);

  return (
    <div
      className={`xterm-interactive flex flex-col rounded-xl overflow-hidden border border-[#2a2d35] shadow-2xl ${className}`}
      style={{
        background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)',
        boxShadow: `0 0 60px -15px ${colors.primary}25, 0 25px 50px -12px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255,255,255,0.02)`,
      }}
      onClick={focus}
    >
      {/* Header */}
      {showHeader && (
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-[#21262d]"
          style={{
            background: 'linear-gradient(180deg, #161b22 0%, #0d1117 100%)',
          }}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              {/* Traffic light buttons */}
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-[#ff5f56] border border-[#e0443e]" />
                <div className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-[#dea123]" />
                <div className="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29]" />
              </div>
            </div>
            <div className="w-px h-4 bg-[#30363d]" />
            <div className="flex items-center gap-2">
              <TerminalIcon />
              <span className="text-sm font-semibold" style={{ color: colors.primary }}>
                {agentName}
              </span>
              <span className="px-1.5 py-0.5 rounded-full bg-accent-purple/20 text-[10px] text-accent-purple uppercase tracking-wider">
                Interactive
              </span>
              <ConnectionBadge isConnected={isConnected} isConnecting={isConnecting} />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Clear logs */}
            <button
              className="p-1.5 rounded-lg hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-all duration-200"
              onClick={clear}
              title="Clear terminal"
            >
              <TrashIcon />
            </button>
            {/* Connection toggle */}
            <button
              className={`p-1.5 rounded-lg transition-all duration-200 ${
                isConnected
                  ? 'hover:bg-[#f85149]/10 text-[#8b949e] hover:text-[#f85149]'
                  : 'bg-[#3fb950]/20 text-[#3fb950] shadow-[0_0_12px_rgba(63,185,80,0.25)]'
              }`}
              onClick={isConnected ? disconnect : connect}
              title={isConnected ? 'Disconnect' : 'Connect'}
            >
              {isConnected ? <PauseIcon /> : <PlayIcon />}
            </button>
            {/* Close button */}
            {onClose && (
              <>
                <div className="w-px h-4 bg-[#30363d] mx-1" />
                <button
                  className="p-1.5 rounded-lg hover:bg-[#f85149]/10 text-[#8b949e] hover:text-[#f85149] transition-all duration-200"
                  onClick={onClose}
                  title="Close"
                >
                  <CloseIcon />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="px-4 py-2 bg-[#3d1d20] border-b border-[#f85149]/30 text-sm text-[#f85149] flex items-center gap-2">
          <ErrorIcon />
          <span>{error.message}</span>
          <button
            className="ml-auto text-xs px-2 py-0.5 rounded bg-[#f85149]/20 hover:bg-[#f85149]/30 transition-colors"
            onClick={connect}
          >
            Retry
          </button>
        </div>
      )}

      {/* Terminal container */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{ maxHeight, minHeight: '300px' }}
      />

      {/* Footer status bar */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-t border-[#21262d] text-xs"
        style={{
          background: 'linear-gradient(180deg, #0d1117 0%, #0a0c10 100%)',
        }}
      >
        <div className="flex items-center gap-3">
          <span className="text-[#6e7681]">
            Type directly to interact with the agent
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[#6e7681] font-mono uppercase tracking-wider text-[10px]">
            Interactive PTY
          </span>
          <div
            className={`w-2 h-2 rounded-full transition-all duration-300 ${
              isConnected
                ? 'bg-[#3fb950]'
                : isConnecting
                ? 'bg-[#d29922] animate-pulse'
                : 'bg-[#484f58]'
            }`}
            style={{
              boxShadow: isConnected ? '0 0 8px rgba(63,185,80,0.6)' : 'none',
            }}
          />
        </div>
      </div>
    </div>
  );
}

// Icon components
function TerminalIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[#8b949e]"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function ConnectionBadge({
  isConnected,
  isConnecting,
}: {
  isConnected: boolean;
  isConnecting: boolean;
}) {
  if (isConnecting) {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#d29922]/20 text-[10px] text-[#d29922] uppercase tracking-wider">
        <span className="w-1.5 h-1.5 rounded-full bg-[#d29922] animate-pulse" />
        connecting
      </span>
    );
  }

  if (isConnected) {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#238636]/20 text-[10px] text-[#3fb950] uppercase tracking-wider">
        <span className="w-1.5 h-1.5 rounded-full bg-[#3fb950] shadow-[0_0_4px_rgba(63,185,80,0.5)]" />
        live
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[#484f58]/20 text-[10px] text-[#484f58] uppercase tracking-wider">
      <span className="w-1.5 h-1.5 rounded-full bg-[#484f58]" />
      offline
    </span>
  );
}

export default XTermInteractive;
