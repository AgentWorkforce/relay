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
import { XTermLogViewer } from './XTermLogViewer';

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
  const [autoScroll, setAutoScroll] = useState(autoScrollDefault);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const {
    logs,
    isConnected,
    isConnecting,
  } = useAgentLogs({ agentName, autoConnect: true });

  const colors = getAgentColor(agentName);

  // Filter logs to remove empty, whitespace-only, and spinner-fragment lines
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const stripped = sanitizeLogContent(log.content).trim();

      // Filter out empty lines
      if (stripped.length === 0) return false;

      // Filter out likely spinner fragments (single char or very short non-word content)
      // Common spinner chars: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ | - \ / * . etc.
      const spinnerPattern = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷◐◓◑◒●○◉◎|\\\/\-*.\u2800-\u28FF]+$/;
      if (stripped.length <= 2 && spinnerPattern.test(stripped)) return false;

      return true;
    });
  }, [logs]);

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

  // Inline mode - compact view
  if (mode === 'inline') {
    return (
      <div
        className={`log-viewer-inline rounded-lg overflow-hidden border border-[#2a2d35] ${className}`}
        style={{
          background: 'linear-gradient(180deg, #0d0f14 0%, #12151c 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.02), 0 4px 12px rgba(0,0,0,0.3)',
        }}
      >
        <div
          className="flex items-center justify-between px-3 py-2 border-b border-[#2a2d35]"
          style={{
            background: 'linear-gradient(180deg, #161b22 0%, #0d1117 100%)',
          }}
        >
          <div className="flex items-center gap-2">
            <TerminalIcon />
            <span
              className="text-xs font-medium"
              style={{ color: colors.primary }}
            >
              Live logs
            </span>
            <ConnectionBadge isConnected={isConnected} isConnecting={isConnecting} />
          </div>
          <div className="flex items-center gap-1">
            <button
              className="p-1.5 rounded-lg hover:bg-[#21262d] text-[#8b949e] hover:text-accent-cyan transition-all duration-200 hover:shadow-[0_0_8px_rgba(0,217,255,0.15)]"
              onClick={onExpand}
              title="Expand"
            >
              <ExpandIcon />
            </button>
          </div>
        </div>
        <div
          className="font-mono text-xs leading-relaxed p-3 overflow-y-auto touch-pan-y"
          style={{
            maxHeight: '150px',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            touchAction: 'pan-y',
          }}
          ref={scrollContainerRef}
          onScroll={handleScroll}
        >
          {filteredLogs.slice(-20).map((log) => (
            <LogLineItem key={log.id} log={log} compact />
          ))}
          {filteredLogs.length === 0 && (
            <div className="text-[#484f58] italic flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#484f58] animate-pulse" />
              Waiting for output...
            </div>
          )}
        </div>
      </div>
    );
  }

  // Panel mode - use xterm.js for proper terminal emulation
  return (
    <XTermLogViewer
      agentName={agentName}
      maxHeight={maxHeight}
      showHeader={showHeader}
      onClose={onClose}
      className={className}
    />
  );
}

// Log line component for inline mode
interface LogLineItemProps {
  log: LogLine;
  compact?: boolean;
}

function LogLineItem({ log, compact = false }: LogLineItemProps) {
  const sanitizedContent = sanitizeLogContent(log.content);

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

  return (
    <div className={`${getTypeStyles()} leading-5 whitespace-pre-wrap break-all min-w-0 overflow-hidden`}>
      {sanitizedContent}
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
 * Strip ANSI escape codes (including degraded sequences like "[38;5;216m")
 * and control characters so logs render as clean text.
 */
function sanitizeLogContent(text: string): string {
  if (!text) return '';

  let result = text;

  // Remove OSC sequences (like window title): \x1b]...(\x07|\x1b\\)
  result = result.replace(/\x1b\].*?(?:\x07|\x1b\\)/gs, '');

  // Remove DCS (Device Control String) sequences: \x1bP...\x1b\\
  result = result.replace(/\x1bP.*?\x1b\\/gs, '');

  // Remove standard ANSI escape sequences (CSI, SGR, etc.)
  result = result.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

  // Remove single-character escapes
  result = result.replace(/\x1b[@-Z\\-_]/g, '');

  // Remove orphaned CSI sequences that lost their escape byte
  result = result.replace(/^\[\??\d+[hlKJHfABCDGPXsu]/gm, '');

  // Remove literal SGR sequences that show up without ESC (e.g. "[38;5;216m")
  result = result.replace(/\[\d+(?:;\d+)*m/g, '');

  // Remove carriage returns/backspaces and other control chars (except newline/tab)
  result = result.replace(/\r/g, '');
  result = result.replace(/.\x08/g, '');
  result = result.replace(/\x08+/g, '');
  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  return result;
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

export default LogViewer;
