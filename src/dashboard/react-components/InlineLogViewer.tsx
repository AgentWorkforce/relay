/**
 * InlineLogViewer Component
 *
 * A compact, embeddable log viewer designed for chat/message contexts.
 * Shows a scrolling preview of agent output with expand capability.
 */

import React, { useState, useRef, useEffect } from 'react';
import { useAgentLogs, type LogLine } from './hooks/useAgentLogs';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface InlineLogViewerProps {
  /** Agent name to stream logs from */
  agentName: string;
  /** Maximum number of visible lines */
  maxVisibleLines?: number;
  /** Maximum height in pixels */
  maxHeight?: number;
  /** Callback when user wants to expand to full view */
  onExpand?: () => void;
  /** Whether to start collapsed */
  startCollapsed?: boolean;
  /** Custom title (default: "Live Output") */
  title?: string;
  /** Show connection status */
  showStatus?: boolean;
}

export function InlineLogViewer({
  agentName,
  maxVisibleLines = 8,
  maxHeight = 200,
  onExpand,
  startCollapsed = false,
  title = 'Live Output',
  showStatus = true,
}: InlineLogViewerProps) {
  const [isCollapsed, setIsCollapsed] = useState(startCollapsed);
  const [isPaused, setIsPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const colors = getAgentColor(agentName);

  const {
    logs,
    isConnected,
    isConnecting,
    disconnect,
    connect,
  } = useAgentLogs({
    agentName,
    autoConnect: true,
    maxLines: 500,
  });

  // Auto-scroll
  useEffect(() => {
    if (!isPaused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isPaused]);

  // Handle pause on manual scroll
  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
      if (!isAtBottom && !isPaused) {
        setIsPaused(true);
      } else if (isAtBottom && isPaused) {
        setIsPaused(false);
      }
    }
  };

  // Connection toggle
  const toggleConnection = () => {
    if (isConnected) {
      disconnect();
    } else {
      connect();
    }
  };

  const visibleLogs = logs.slice(-maxVisibleLines * 3);
  const hasMoreLogs = logs.length > maxVisibleLines * 3;

  return (
    <div
      className="inline-log-viewer rounded-xl overflow-hidden border border-[#2a2d35] my-2"
      style={{
        background: 'linear-gradient(135deg, #0d0f14 0%, #12151c 50%, #0d0f14 100%)',
        boxShadow: `
          inset 0 1px 0 rgba(255,255,255,0.03),
          0 4px 20px rgba(0,0,0,0.4),
          0 0 30px -10px ${colors.primary}20
        `,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 cursor-pointer select-none border-b border-[#21262d]"
        onClick={() => setIsCollapsed(!isCollapsed)}
        style={{
          background: 'linear-gradient(180deg, rgba(22,27,34,0.95) 0%, rgba(13,17,23,0.98) 100%)',
        }}
      >
        <div className="flex items-center gap-2.5">
          {/* Agent indicator with shine */}
          <div
            className="relative w-6 h-6 rounded-lg flex items-center justify-center text-[9px] font-bold overflow-hidden"
            style={{
              backgroundColor: colors.primary,
              color: colors.text,
              boxShadow: `0 0 12px ${colors.primary}50`,
            }}
          >
            {/* Shine overlay */}
            <div
              className="absolute inset-0 opacity-30"
              style={{
                background: 'linear-gradient(135deg, rgba(255,255,255,0.3) 0%, transparent 50%)',
              }}
            />
            <span className="relative z-10">{getAgentInitials(agentName)}</span>
          </div>

          {/* Title and status */}
          <div className="flex items-center gap-2">
            <span
              className="text-xs font-semibold tracking-tight"
              style={{ color: colors.primary }}
            >
              {title}
            </span>
            {showStatus && (
              <StatusIndicator
                isConnected={isConnected}
                isConnecting={isConnecting}
                logCount={logs.length}
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Connection toggle */}
          <button
            className={`p-1.5 rounded-lg transition-all duration-200 ${
              isConnected
                ? 'text-[#3fb950] hover:bg-[#3fb950]/15 hover:shadow-[0_0_8px_rgba(63,185,80,0.2)]'
                : 'text-[#8b949e] hover:bg-[#21262d] hover:text-[#c9d1d9]'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              toggleConnection();
            }}
            title={isConnected ? 'Pause stream' : 'Resume stream'}
          >
            {isConnected ? <PauseIcon /> : <PlayIcon />}
          </button>

          {/* Expand button */}
          {onExpand && (
            <button
              className="p-1.5 rounded-lg text-[#8b949e] hover:text-accent-cyan hover:bg-accent-cyan/10 transition-all duration-200 hover:shadow-[0_0_8px_rgba(0,217,255,0.15)]"
              onClick={(e) => {
                e.stopPropagation();
                onExpand();
              }}
              title="Open full view"
            >
              <ExpandIcon />
            </button>
          )}

          {/* Collapse toggle */}
          <button
            className="p-1.5 rounded-lg text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d] transition-all duration-200"
            onClick={(e) => {
              e.stopPropagation();
              setIsCollapsed(!isCollapsed);
            }}
          >
            <ChevronIcon isOpen={!isCollapsed} />
          </button>
        </div>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div
          ref={scrollRef}
          className="overflow-y-auto overflow-x-hidden font-mono text-xs"
          style={{ maxHeight: `${maxHeight}px` }}
          onScroll={handleScroll}
        >
          {/* "More logs above" indicator */}
          {hasMoreLogs && (
            <div className="flex items-center justify-center gap-2 py-1.5 text-[10px] text-[#484f58] border-b border-[#21262d]/50">
              <DotsIcon />
              <span>{logs.length - visibleLogs.length} more lines above</span>
            </div>
          )}

          {/* Log lines */}
          <div className="p-2 space-y-px">
            {visibleLogs.length === 0 ? (
              <div className="flex items-center gap-2 py-3 justify-center text-[#484f58]">
                {isConnecting ? (
                  <>
                    <LoadingDots />
                    <span>Connecting...</span>
                  </>
                ) : (
                  <>
                    <WaitingIcon />
                    <span>Waiting for output...</span>
                  </>
                )}
              </div>
            ) : (
              visibleLogs.map((log) => (
                <InlineLogLine key={log.id} log={log} />
              ))
            )}
          </div>

          {/* Paused indicator */}
          {isPaused && logs.length > 0 && (
            <div
              className="sticky bottom-0 flex items-center justify-center gap-2 py-1.5 text-[10px] bg-[#21262d]/90 backdrop-blur-sm cursor-pointer hover:bg-[#30363d]/90 transition-colors"
              onClick={() => {
                setIsPaused(false);
                if (scrollRef.current) {
                  scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
              }}
            >
              <ArrowDownIcon />
              <span className="text-[#8b949e]">New output below - click to scroll</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Individual log line
function InlineLogLine({ log }: { log: LogLine }) {
  const getTypeColor = () => {
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
    <div
      className={`group leading-5 px-1.5 py-0.5 rounded-md transition-all duration-150 border-l-2 border-transparent hover:bg-[#21262d]/60 hover:border-[#30363d] ${getTypeColor()}`}
      style={{
        wordBreak: 'break-all',
        whiteSpace: 'pre-wrap',
      }}
    >
      {log.content}
      {log.type === 'stderr' && (
        <span
          className="ml-2 text-[8px] uppercase tracking-wider px-1 py-0.5 rounded opacity-70"
          style={{
            color: '#f85149',
            background: 'rgba(248, 81, 73, 0.15)',
          }}
        >
          err
        </span>
      )}
    </div>
  );
}

// Status indicator
function StatusIndicator({
  isConnected,
  isConnecting,
  logCount,
}: {
  isConnected: boolean;
  isConnecting: boolean;
  logCount: number;
}) {
  if (isConnecting) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-[#d29922]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#d29922] animate-pulse" />
        connecting
      </span>
    );
  }

  if (isConnected) {
    return (
      <span className="flex items-center gap-1.5 text-[10px] text-[#3fb950]">
        <span
          className="w-1.5 h-1.5 rounded-full bg-[#3fb950]"
          style={{ boxShadow: '0 0 4px rgba(63,185,80,0.6)' }}
        />
        <span className="tabular-nums">{logCount}</span>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-[10px] text-[#484f58]">
      <span className="w-1.5 h-1.5 rounded-full bg-[#484f58]" />
      paused
    </span>
  );
}

// Loading dots animation
function LoadingDots() {
  return (
    <span className="flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1 h-1 rounded-full bg-[#484f58] animate-pulse"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

// Icons
function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function ChevronIcon({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      style={{
        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 0.2s',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function WaitingIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

export default InlineLogViewer;
