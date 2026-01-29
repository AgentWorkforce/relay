/**
 * XTermLogViewer Component
 *
 * Terminal-based log viewer using xterm.js for proper ANSI sequence handling.
 * Used in panel mode for full terminal emulation with colors and formatting.
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { getAgentColor } from '../lib/colors';
import { useWorkspaceWsUrl } from './WorkspaceContext';

export interface XTermLogViewerProps {
  /** Agent name to stream logs from */
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

// getLogStreamUrl removed - now using useWorkspaceWsUrl hook

export function XTermLogViewer({
  agentName,
  maxHeight = '500px',
  showHeader = true,
  onClose,
  className = '',
}: XTermLogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);

  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [lineCount, setLineCount] = useState(0);
  const [isTerminalReady, setIsTerminalReady] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const colors = getAgentColor(agentName);

  // Get WebSocket URL from workspace context (handles cloud vs local mode)
  const logStreamUrl = useWorkspaceWsUrl(`/ws/logs/${encodeURIComponent(agentName)}`);

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
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true, // Read-only log viewer
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    setIsTerminalReady(true);

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
      searchAddonRef.current = null;
      setIsTerminalReady(false);
    };
  }, []);

  // Mobile touch scrolling - attach handlers to container, not viewport
  // xterm.js renders to a canvas which intercepts events; we need to handle
  // touch scrolling at the container level and use xterm's scroll API directly
  useEffect(() => {
    if (!containerRef.current || !isTerminalReady || !terminalRef.current) return;

    // Only enable on touch devices
    if (typeof window !== 'undefined' &&
        !window.matchMedia('(pointer: coarse)').matches) {
      return;
    }

    const container = containerRef.current;
    const terminal = terminalRef.current;

    // Calculate line height from terminal settings
    const fontSize = 12; // matches Terminal config
    const lineHeight = 1.4; // matches Terminal config
    const lineHeightPx = fontSize * lineHeight;

    let startY = 0;
    let lastY = 0;
    let scrollAccumulator = 0; // accumulate sub-line scroll deltas
    let isTouchScrolling = false;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
      lastY = startY;
      scrollAccumulator = 0;
      isTouchScrolling = false;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;

      const currentY = event.touches[0].clientY;
      const delta = lastY - currentY; // positive = scroll down
      lastY = currentY;

      // Determine if this is a scroll gesture (vs a tap)
      if (!isTouchScrolling && Math.abs(currentY - startY) > 10) {
        isTouchScrolling = true;
      }

      if (!isTouchScrolling) return;

      // Accumulate scroll delta for smooth scrolling
      scrollAccumulator += delta;

      // Convert accumulated pixels to lines and scroll
      const linesToScroll = Math.trunc(scrollAccumulator / lineHeightPx);
      if (linesToScroll !== 0) {
        terminal.scrollLines(linesToScroll);
        scrollAccumulator -= linesToScroll * lineHeightPx;
      }

      // Prevent page scroll while scrolling terminal content
      event.preventDefault();
    };

    const handleTouchEnd = () => {
      isTouchScrolling = false;
      scrollAccumulator = 0;
    };

    // Attach to container - this captures touches over the entire terminal area
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [isTerminalReady]);

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

      terminalRef.current?.writeln(`\x1b[90m[Connected to ${agentName} log stream]\x1b[0m`);
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
            setLineCount((c) => c + 1);
          });
          return;
        }

        // Handle live output
        if (data.type === 'log' || data.type === 'output') {
          const content = data.content || data.data || data.message || '';
          if (content) {
            // Write raw content - xterm.js handles ANSI codes natively
            terminalRef.current?.write(content);
            // Count newlines for line count
            const newlines = (content.match(/\n/g) || []).length;
            if (newlines > 0) {
              setLineCount((c) => c + newlines);
            }
          }
          return;
        }

        // Handle batch of lines
        if (data.lines && Array.isArray(data.lines)) {
          data.lines.forEach((line: string | { content: string }) => {
            const content = typeof line === 'string' ? line : line.content;
            terminalRef.current?.writeln(content);
            setLineCount((c) => c + 1);
          });
        }
      } catch {
        // Plain text message
        if (typeof event.data === 'string') {
          terminalRef.current?.write(event.data);
          const newlines = (event.data.match(/\n/g) || []).length;
          if (newlines > 0) {
            setLineCount((c) => c + newlines);
          }
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
    setLineCount(0);
  }, []);

  // Search functionality
  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    if (query && searchAddonRef.current) {
      searchAddonRef.current.findNext(query, { caseSensitive: false });
    }
  }, []);

  const findNext = useCallback(() => {
    if (searchQuery && searchAddonRef.current) {
      searchAddonRef.current.findNext(searchQuery, { caseSensitive: false });
    }
  }, [searchQuery]);

  const findPrevious = useCallback(() => {
    if (searchQuery && searchAddonRef.current) {
      searchAddonRef.current.findPrevious(searchQuery, { caseSensitive: false });
    }
  }, [searchQuery]);

  // Auto-connect on mount
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + F to open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      // Escape to close search
      if (e.key === 'Escape' && isSearchOpen) {
        setIsSearchOpen(false);
        setSearchQuery('');
      }
      // Enter to find next
      if (e.key === 'Enter' && isSearchOpen) {
        e.preventDefault();
        if (e.shiftKey) {
          findPrevious();
        } else {
          findNext();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSearchOpen, findNext, findPrevious]);

  return (
    <div
      className={`xterm-log-viewer flex flex-col min-h-0 rounded-xl overflow-hidden border border-[#2a2d35] shadow-2xl ${className}`}
      style={{
        background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)',
        boxShadow: `0 0 60px -15px ${colors.primary}25, 0 25px 50px -12px rgba(0, 0, 0, 0.8), inset 0 1px 0 rgba(255,255,255,0.02)`,
      }}
    >
      {/* Mobile touch scroll styles for xterm.js
          Touch scrolling is handled via JavaScript (touchstart/touchmove on container).
          We set touch-action: none to prevent browser's default scroll handling
          so our custom handler has full control. */}
      <style>{`
        .xterm-log-viewer .xterm {
          height: 100%;
        }
        .xterm-log-viewer .xterm-viewport {
          height: 100%;
          max-height: 100%;
          overscroll-behavior: contain;
        }
        /* On touch devices, disable browser touch handling so our JS handler works */
        @media (pointer: coarse) {
          .xterm-log-viewer .xterm,
          .xterm-log-viewer .xterm-viewport,
          .xterm-log-viewer .xterm-screen,
          .xterm-log-viewer .xterm-screen canvas {
            touch-action: none;
          }
        }
      `}</style>
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
                <div className="w-3 h-3 rounded-full bg-[#ff5f56] border border-[#e0443e] transition-shadow hover:shadow-[0_0_8px_rgba(255,95,86,0.5)]" />
                <div className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-[#dea123] transition-shadow hover:shadow-[0_0_8px_rgba(255,189,46,0.5)]" />
                <div className="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29] transition-shadow hover:shadow-[0_0_8px_rgba(39,201,63,0.5)]" />
              </div>
            </div>
            <div className="w-px h-4 bg-[#30363d]" />
            <div className="flex items-center gap-2">
              <TerminalIcon />
              <span className="text-sm font-semibold" style={{ color: colors.primary }}>
                {agentName}
              </span>
              <ConnectionBadge isConnected={isConnected} isConnecting={isConnecting} />
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Search toggle */}
            <button
              className={`p-1.5 rounded-lg transition-all duration-200 ${
                isSearchOpen
                  ? 'bg-accent-cyan/20 text-accent-cyan shadow-[0_0_12px_rgba(0,217,255,0.25)]'
                  : 'hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
              onClick={() => {
                setIsSearchOpen(!isSearchOpen);
                if (!isSearchOpen) {
                  setTimeout(() => searchInputRef.current?.focus(), 0);
                }
              }}
              title="Search (Cmd+F)"
            >
              <SearchIcon />
            </button>
            {/* Clear logs */}
            <button
              className="p-1.5 rounded-lg hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-all duration-200"
              onClick={clear}
              title="Clear logs"
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

      {/* Search bar */}
      {isSearchOpen && (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[#21262d] bg-[#161b22]">
          <SearchIcon />
          <input
            ref={searchInputRef}
            type="text"
            className="flex-1 bg-transparent border-none text-sm text-[#c9d1d9] placeholder:text-[#484f58] outline-none font-mono"
            placeholder="Search logs... (Enter: next, Shift+Enter: prev)"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
          />
          <div className="flex items-center gap-1">
            <button
              className="px-2 py-0.5 text-xs rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
              onClick={findPrevious}
              title="Previous (Shift+Enter)"
            >
              &uarr;
            </button>
            <button
              className="px-2 py-0.5 text-xs rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
              onClick={findNext}
              title="Next (Enter)"
            >
              &darr;
            </button>
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

      {/* Terminal container - touch handlers attached via useEffect */}
      <div
        className="flex-1 min-h-0 overflow-hidden"
        style={{ height: maxHeight, maxHeight, minHeight: '200px' }}
      >
        <div
          ref={containerRef}
          className="h-full w-full"
        />
      </div>

      {/* Footer status bar */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-t border-[#21262d] text-xs"
        style={{
          background: 'linear-gradient(180deg, #0d1117 0%, #0a0c10 100%)',
        }}
      >
        <div className="flex items-center gap-3">
          <span className="tabular-nums font-mono text-[#6e7681]">{lineCount} lines</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[#6e7681] font-mono uppercase tracking-wider text-[10px]">
            PTY stream
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

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-[#8b949e]"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
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

export default XTermLogViewer;
