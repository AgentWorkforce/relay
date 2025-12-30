/**
 * LogViewer Component
 *
 * A real-time PTY log viewer with terminal-inspired aesthetics.
 * Supports inline (embedded in chat) and dedicated panel modes.
 * Features auto-scroll, search/filter, and ANSI color parsing.
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAgentLogs, type LogLine } from './hooks/useAgentLogs';
import { getAgentColor } from '../lib/colors';

export type LogViewerMode = 'inline' | 'panel';

export interface LogViewerProps {
  /** Agent name to stream logs from */
  agentName: string;
  /** Display mode: inline (compact) or panel (full-featured) */
  mode?: LogViewerMode;
  /** Maximum height in panel mode */
  maxHeight?: string;
  /** Whether to show the header bar */
  showHeader?: boolean;
  /** Whether to enable auto-scroll by default */
  autoScrollDefault?: boolean;
  /** Callback when close button is clicked (panel mode) */
  onClose?: () => void;
  /** Callback when expand button is clicked (inline mode) */
  onExpand?: () => void;
  /** Custom class name */
  className?: string;
}

export function LogViewer({
  agentName,
  mode = 'panel',
  maxHeight = '500px',
  showHeader = true,
  autoScrollDefault = true,
  onClose,
  onExpand,
  className = '',
}: LogViewerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(autoScrollDefault);
  const [filterType, setFilterType] = useState<'all' | 'stdout' | 'stderr' | 'system'>('all');

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const {
    logs,
    isConnected,
    isConnecting,
    error,
    connect,
    disconnect,
    clear,
  } = useAgentLogs({ agentName, autoConnect: true });

  const colors = getAgentColor(agentName);

  // Filter logs based on search and type
  const filteredLogs = useMemo(() => {
    let result = logs;

    // Filter by type
    if (filterType !== 'all') {
      result = result.filter((log) => log.type === filterType);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter((log) =>
        log.content.toLowerCase().includes(query)
      );
    }

    return result;
  }, [logs, filterType, searchQuery]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      container.scrollTop = container.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Handle scroll to detect manual scroll (disable/enable auto-scroll)
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 50;

    // Re-enable auto-scroll when user scrolls to bottom
    if (isAtBottom && !autoScroll) {
      setAutoScroll(true);
    }
    // Disable auto-scroll when user scrolls away from bottom
    else if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + F to open search
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && mode === 'panel') {
        e.preventDefault();
        setIsSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      // Escape to close search
      if (e.key === 'Escape' && isSearchOpen) {
        setIsSearchOpen(false);
        setSearchQuery('');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, isSearchOpen]);

  // Inline mode - compact view
  if (mode === 'inline') {
    return (
      <div
        className={`log-viewer-inline rounded-lg overflow-hidden border border-[#2a2d35] ${className}`}
        style={{
          background: 'linear-gradient(180deg, #0d0f14 0%, #12151c 100%)',
        }}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a2d35] bg-[#0a0c10]">
          <div className="flex items-center gap-2">
            <TerminalIcon />
            <span className="text-xs font-medium text-[#8b949e]">
              Live logs
            </span>
            <ConnectionBadge isConnected={isConnected} isConnecting={isConnecting} />
          </div>
          <div className="flex items-center gap-1">
            <button
              className="p-1 rounded hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
              onClick={onExpand}
              title="Expand"
            >
              <ExpandIcon />
            </button>
          </div>
        </div>
        <div
          className="font-mono text-xs leading-relaxed p-3 overflow-y-auto"
          style={{ maxHeight: '150px' }}
          ref={scrollContainerRef}
          onScroll={handleScroll}
        >
          {filteredLogs.slice(-20).map((log) => (
            <LogLineItem key={log.id} log={log} compact />
          ))}
          {filteredLogs.length === 0 && (
            <div className="text-[#484f58] italic">Waiting for output...</div>
          )}
        </div>
      </div>
    );
  }

  // Panel mode - full-featured view
  return (
    <div
      className={`log-viewer-panel flex flex-col rounded-xl overflow-hidden border border-[#2a2d35] shadow-2xl ${className}`}
      style={{
        background: 'linear-gradient(180deg, #0d0f14 0%, #0a0c10 100%)',
        boxShadow: `0 0 60px -15px ${colors.primary}15, 0 25px 50px -12px rgba(0, 0, 0, 0.8)`,
      }}
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
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-[#ff5f56] border border-[#e0443e]" />
                <div className="w-3 h-3 rounded-full bg-[#ffbd2e] border border-[#dea123]" />
                <div className="w-3 h-3 rounded-full bg-[#27c93f] border border-[#1aab29]" />
              </div>
            </div>
            <div className="w-px h-4 bg-[#30363d]" />
            <div className="flex items-center gap-2">
              <TerminalIcon />
              <span className="text-sm font-semibold text-[#c9d1d9]">
                {agentName}
              </span>
              <ConnectionBadge isConnected={isConnected} isConnecting={isConnecting} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Search toggle */}
            <button
              className={`p-1.5 rounded-md transition-colors ${
                isSearchOpen
                  ? 'bg-[#238636] text-white'
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
              className="p-1.5 rounded-md hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
              onClick={clear}
              title="Clear logs"
            >
              <TrashIcon />
            </button>
            {/* Auto-scroll toggle */}
            <button
              className={`p-1.5 rounded-md transition-colors ${
                autoScroll
                  ? 'bg-[#238636] text-white'
                  : 'hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]'
              }`}
              onClick={() => setAutoScroll(!autoScroll)}
              title={autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
            >
              <ArrowDownIcon />
            </button>
            {/* Connection toggle */}
            <button
              className={`p-1.5 rounded-md transition-colors ${
                isConnected
                  ? 'hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]'
                  : 'bg-[#238636] text-white'
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
                  className="p-1.5 rounded-md hover:bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
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
            placeholder="Search logs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="flex items-center gap-1">
            {(['all', 'stdout', 'stderr', 'system'] as const).map((type) => (
              <button
                key={type}
                className={`px-2 py-0.5 text-xs rounded transition-colors ${
                  filterType === type
                    ? 'bg-[#238636] text-white'
                    : 'bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9]'
                }`}
                onClick={() => setFilterType(type)}
              >
                {type}
              </button>
            ))}
          </div>
          <span className="text-xs text-[#484f58] tabular-nums">
            {filteredLogs.length} / {logs.length}
          </span>
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

      {/* Log content */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden font-mono text-sm p-4"
        style={{ maxHeight }}
        onScroll={handleScroll}
      >
        {filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[#484f58] gap-3">
            {isConnecting ? (
              <>
                <LoadingSpinner />
                <span>Connecting to {agentName}...</span>
              </>
            ) : logs.length === 0 ? (
              <>
                <TerminalIcon size={32} />
                <span>Waiting for output...</span>
              </>
            ) : (
              <>
                <SearchIcon />
                <span>No matches for "{searchQuery}"</span>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-px">
            {filteredLogs.map((log, index) => (
              <LogLineItem
                key={log.id}
                log={log}
                showTimestamp
                isHighlighted={!!(searchQuery && log.content.toLowerCase().includes(searchQuery.toLowerCase()))}
                searchQuery={searchQuery}
                lineNumber={index + 1}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer status bar */}
      <div className="flex items-center justify-between px-4 py-2 border-t border-[#21262d] bg-[#0d1117] text-xs text-[#484f58]">
        <div className="flex items-center gap-3">
          <span className="tabular-nums">{logs.length} lines</span>
          {!autoScroll && (
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#21262d] text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
              onClick={() => {
                setAutoScroll(true);
                if (scrollContainerRef.current) {
                  scrollContainerRef.current.scrollTop =
                    scrollContainerRef.current.scrollHeight;
                }
              }}
            >
              <ArrowDownIcon />
              <span>Jump to bottom</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span>PTY stream</span>
          <div
            className={`w-2 h-2 rounded-full ${
              isConnected
                ? 'bg-[#3fb950] shadow-[0_0_6px_rgba(63,185,80,0.5)]'
                : isConnecting
                ? 'bg-[#d29922] animate-pulse'
                : 'bg-[#484f58]'
            }`}
          />
        </div>
      </div>
    </div>
  );
}

// Log line component
interface LogLineItemProps {
  log: LogLine;
  compact?: boolean;
  showTimestamp?: boolean;
  isHighlighted?: boolean;
  searchQuery?: string;
  lineNumber?: number;
}

function LogLineItem({
  log,
  compact = false,
  showTimestamp = false,
  isHighlighted = false,
  searchQuery = '',
  lineNumber,
}: LogLineItemProps) {
  const timestamp = new Date(log.timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const getTypeStyles = () => {
    switch (log.type) {
      case 'stderr':
        return 'text-[#f85149]';
      case 'system':
        return 'text-[#58a6ff] italic';
      case 'input':
        return 'text-[#d29922]';
      default:
        return 'text-[#c9d1d9]';
    }
  };

  // Highlight search matches in content
  const highlightContent = (content: string) => {
    if (!searchQuery || !searchQuery.trim()) {
      return parseAnsiColors(content);
    }

    const regex = new RegExp(`(${escapeRegExp(searchQuery)})`, 'gi');
    const parts = content.split(regex);

    return parts.map((part, i) => {
      if (part.toLowerCase() === searchQuery.toLowerCase()) {
        return (
          <mark
            key={i}
            className="bg-[#634d00] text-[#ffdf5d] rounded px-0.5"
          >
            {part}
          </mark>
        );
      }
      return parseAnsiColors(part);
    });
  };

  if (compact) {
    return (
      <div className={`${getTypeStyles()} leading-5 whitespace-pre-wrap break-all`}>
        {parseAnsiColors(log.content)}
      </div>
    );
  }

  return (
    <div
      className={`group flex gap-2 py-0.5 px-2 -mx-2 rounded transition-colors ${
        isHighlighted
          ? 'bg-[#634d00]/20'
          : 'hover:bg-[#161b22]'
      }`}
    >
      {lineNumber !== undefined && (
        <span className="w-10 text-right text-[#484f58] select-none shrink-0 tabular-nums">
          {lineNumber}
        </span>
      )}
      {showTimestamp && (
        <span className="text-[#484f58] select-none shrink-0 tabular-nums">
          {timestamp}
        </span>
      )}
      <span
        className={`flex-1 whitespace-pre-wrap break-all ${getTypeStyles()}`}
      >
        {highlightContent(log.content)}
      </span>
      {log.type === 'stderr' && (
        <span className="shrink-0 text-[10px] text-[#f85149]/60 uppercase tracking-wider">
          err
        </span>
      )}
    </div>
  );
}

// Connection status badge
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

/**
 * Strip non-color ANSI escape sequences that we don't want to display.
 * This includes cursor movement, screen clearing, window title, etc.
 * We preserve color codes (ending in 'm') for parseAnsiColors to handle.
 */
function stripNonColorAnsi(text: string): string {
  // Remove OSC sequences (like window title): \x1b]...(\x07|\x1b\\)
  let result = text.replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '');

  // Remove CSI sequences that are NOT color codes (don't end in 'm')
  // This includes: cursor movement, clear screen, scroll, etc.
  result = result.replace(/\x1b\[[0-9;?]*[A-LNS-Zsu]/gi, '');

  // Remove other escape sequences
  // - \x1b followed by single char (like \x1b7, \x1b8 for save/restore cursor)
  // - \x1b( and \x1b) for charset switching
  result = result.replace(/\x1b[78()]/g, '');

  // Remove carriage returns (often used with escape sequences for cursor control)
  result = result.replace(/\r/g, '');

  // Remove orphaned CSI sequences that lost their escape byte (common in PTY output)
  result = result.replace(/^\[\??\d+[hlKJHfABCDGPXsu]/gm, '');

  return result;
}

// ANSI color parser (basic implementation)
function parseAnsiColors(text: string): React.ReactNode {
  // First strip non-color escape sequences
  const cleanedText = stripNonColorAnsi(text);

  // Basic ANSI color code patterns
  const ansiPattern = /\x1b\[(\d+(?:;\d+)*)m/g;

  if (!ansiPattern.test(cleanedText)) {
    return cleanedText;
  }

  // Reset pattern position
  ansiPattern.lastIndex = 0;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let currentStyle: Record<string, string> = {};
  let match;

  while ((match = ansiPattern.exec(cleanedText)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      parts.push(
        <span key={`text-${lastIndex}`} style={currentStyle}>
          {cleanedText.slice(lastIndex, match.index)}
        </span>
      );
    }

    // Parse ANSI codes
    const codes = match[1].split(';').map(Number);
    currentStyle = { ...currentStyle, ...ansiCodesToStyle(codes) };

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < cleanedText.length) {
    parts.push(
      <span key={`text-${lastIndex}`} style={currentStyle}>
        {cleanedText.slice(lastIndex)}
      </span>
    );
  }

  return parts.length > 0 ? <>{parts}</> : cleanedText;
}

function ansiCodesToStyle(codes: number[]): Record<string, string> {
  const style: Record<string, string> = {};

  for (const code of codes) {
    switch (code) {
      case 0:
        return {}; // Reset
      case 1:
        style.fontWeight = 'bold';
        break;
      case 2:
        style.opacity = '0.7';
        break;
      case 3:
        style.fontStyle = 'italic';
        break;
      case 4:
        style.textDecoration = 'underline';
        break;
      case 30:
        style.color = '#484f58';
        break;
      case 31:
        style.color = '#f85149';
        break;
      case 32:
        style.color = '#3fb950';
        break;
      case 33:
        style.color = '#d29922';
        break;
      case 34:
        style.color = '#58a6ff';
        break;
      case 35:
        style.color = '#bc8cff';
        break;
      case 36:
        style.color = '#39c5cf';
        break;
      case 37:
        style.color = '#c9d1d9';
        break;
      case 90:
        style.color = '#6e7681';
        break;
      case 91:
        style.color = '#ff7b72';
        break;
      case 92:
        style.color = '#56d364';
        break;
      case 93:
        style.color = '#e3b341';
        break;
      case 94:
        style.color = '#79c0ff';
        break;
      case 95:
        style.color = '#d2a8ff';
        break;
      case 96:
        style.color = '#56d4dd';
        break;
      case 97:
        style.color = '#f0f6fc';
        break;
    }
  }

  return style;
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Icon components
function TerminalIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="32"
        strokeLinecap="round"
        className="text-[#484f58]"
      />
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="32"
        strokeDashoffset="24"
        strokeLinecap="round"
        className="text-[#3fb950]"
      />
    </svg>
  );
}

export default LogViewer;
