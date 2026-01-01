/**
 * ThreadList Component
 *
 * Displays a list of active threads in the sidebar with unread indicators.
 * Features a refined design with subtle glows and smooth transitions.
 */

import React from 'react';
import type { ThreadInfo } from './hooks/useMessages';

export interface ThreadListProps {
  threads: ThreadInfo[];
  currentThread?: string | null;
  onThreadSelect: (threadId: string) => void;
  /** Total unread count for the threads section header badge */
  totalUnreadCount?: number;
  /** Whether the threads section is collapsed */
  isCollapsed?: boolean;
  /** Callback to toggle the collapsed state */
  onToggleCollapse?: () => void;
}

export function ThreadList({
  threads,
  currentThread,
  onThreadSelect,
  totalUnreadCount = 0,
  isCollapsed = false,
  onToggleCollapse,
}: ThreadListProps) {
  if (threads.length === 0) {
    return null;
  }

  return (
    <div className="px-2 py-2">
      {/* Section Header */}
      <button
        className="w-full flex items-center justify-between px-2 py-2 mb-1.5 bg-transparent border-none cursor-pointer rounded-lg transition-all duration-200 hover:bg-gradient-to-r hover:from-[rgba(255,255,255,0.03)] hover:to-transparent"
        onClick={onToggleCollapse}
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand threads' : 'Collapse threads'}
      >
        <div className="flex items-center gap-2">
          <CollapseIcon isCollapsed={isCollapsed} />
          <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Threads
          </span>
          <span className="text-xs text-text-dim font-mono">({threads.length})</span>
        </div>
        {totalUnreadCount > 0 && (
          <span
            className="min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold bg-accent-cyan text-bg-deep rounded-full px-1.5"
            style={{ boxShadow: '0 0 8px rgba(0, 217, 255, 0.5)' }}
          >
            {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
          </span>
        )}
      </button>

      {/* Thread Items - only show when not collapsed */}
      {!isCollapsed && (
        <div className="space-y-1">
          {threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              isSelected={currentThread === thread.id}
              onClick={() => onThreadSelect(thread.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ThreadItemProps {
  thread: ThreadInfo;
  isSelected: boolean;
  onClick: () => void;
}

function ThreadItem({ thread, isSelected, onClick }: ThreadItemProps) {
  const hasUnread = thread.unreadCount > 0;
  const timestamp = formatRelativeTime(thread.lastMessage.timestamp);

  return (
    <button
      className={`
        group w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-left transition-all duration-200 cursor-pointer border-none
        hover:bg-gradient-to-r hover:from-[rgba(255,255,255,0.03)] hover:to-transparent
        ${isSelected
          ? 'bg-gradient-to-r from-[rgba(255,255,255,0.06)] to-transparent'
          : 'bg-transparent'
        }
      `}
      onClick={onClick}
      style={{
        borderLeft: isSelected ? '2px solid #00d9ff' : '2px solid transparent',
        boxShadow: isSelected ? 'inset 4px 0 12px -4px rgba(0, 217, 255, 0.25)' : 'none',
      }}
    >
      {/* Thread Icon */}
      <div
        className={`
          relative shrink-0 w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden transition-all duration-200
          ${hasUnread ? 'text-accent-cyan' : 'text-text-muted'}
        `}
        style={{
          background: hasUnread
            ? 'linear-gradient(135deg, rgba(0, 217, 255, 0.2), rgba(0, 217, 255, 0.1))'
            : 'rgba(255, 255, 255, 0.03)',
          boxShadow: hasUnread ? '0 0 8px rgba(0, 217, 255, 0.2)' : 'none',
        }}
      >
        {/* Subtle shine overlay */}
        <div
          className="absolute inset-0 opacity-20"
          style={{
            background: 'linear-gradient(135deg, rgba(255,255,255,0.2) 0%, transparent 50%)',
          }}
        />
        <ThreadIcon />
      </div>

      {/* Thread Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`
            text-[13px] truncate transition-colors duration-200
            ${hasUnread ? 'font-semibold text-text-primary' : 'text-text-secondary group-hover:text-text-primary'}
          `}>
            {thread.name}
          </span>
          {hasUnread && (
            <span
              className="shrink-0 min-w-[16px] h-[16px] flex items-center justify-center text-[9px] font-bold bg-accent-cyan text-bg-deep rounded-full px-1"
              style={{ boxShadow: '0 0 6px rgba(0, 217, 255, 0.4)' }}
            >
              {thread.unreadCount > 99 ? '99+' : thread.unreadCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted font-mono">
          <span className="truncate">{thread.participants.slice(0, 2).join(', ')}</span>
          {thread.participants.length > 2 && (
            <span className="text-text-dim">+{thread.participants.length - 2}</span>
          )}
          <span className="text-text-dim opacity-50">·</span>
          <span className="text-text-dim">{timestamp}</span>
        </div>
      </div>
    </button>
  );
}

function formatRelativeTime(timestamp: string | number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function ThreadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CollapseIcon({ isCollapsed }: { isCollapsed: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-text-muted transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
