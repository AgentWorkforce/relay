/**
 * ChannelBrowser Component
 *
 * A modal for browsing, searching, and joining public channels.
 * Includes search with debouncing and pagination.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useChannelBrowser, type BrowseChannel } from './hooks/useChannelBrowser';
import { Pagination } from './Pagination';

export interface ChannelBrowserProps {
  /** Workspace ID for API calls */
  workspaceId: string;
  isOpen: boolean;
  onClose: () => void;
  onChannelJoined?: (channel: BrowseChannel) => void;
  currentUserId?: string;
}

export function ChannelBrowser({
  workspaceId,
  isOpen,
  onClose,
  onChannelJoined,
}: ChannelBrowserProps) {
  const {
    channels,
    isLoading,
    error,
    searchQuery,
    setSearchQuery,
    currentPage,
    totalPages,
    totalCount,
    goToPage,
    joinChannel,
    leaveChannel,
    refresh,
  } = useChannelBrowser({ workspaceId, autoFetch: isOpen });

  const [joiningChannelId, setJoiningChannelId] = useState<string | null>(null);
  const [leavingChannelId, setLeavingChannelId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle join channel
  const handleJoin = useCallback(async (channel: BrowseChannel) => {
    setJoiningChannelId(channel.id);
    try {
      await joinChannel(channel.id);
      onChannelJoined?.({ ...channel, isJoined: true });
    } catch (err) {
      console.error('Failed to join channel:', err);
    } finally {
      setJoiningChannelId(null);
    }
  }, [joinChannel, onChannelJoined]);

  // Handle leave channel
  const handleLeave = useCallback(async (channel: BrowseChannel) => {
    setLeavingChannelId(channel.id);
    try {
      await leaveChannel(channel.id);
    } catch (err) {
      console.error('Failed to leave channel:', err);
    } finally {
      setLeavingChannelId(null);
    }
  }, [leaveChannel]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[10vh] z-[1000] animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-sidebar-bg border border-sidebar-border rounded-xl w-[600px] max-w-[90vw] max-h-[75vh] flex flex-col shadow-modal animate-slide-down"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-sidebar-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-accent-cyan/20 to-blue-500/20 flex items-center justify-center border border-accent-cyan/30">
              <HashIcon />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary m-0">
                Browse Channels
              </h2>
              <p className="text-xs text-text-muted m-0">
                {totalCount} channel{totalCount !== 1 ? 's' : ''} available
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-sidebar-border transition-colors"
            title="Close (Esc)"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Search */}
        <div className="p-4 border-b border-sidebar-border">
          <div className="relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search channels..."
              className="w-full pl-10 pr-4 py-2.5 bg-bg-tertiary border border-sidebar-border rounded-lg text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-accent-cyan/50 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                title="Clear search"
              >
                <CloseIcon className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Channel List */}
        <div className="flex-1 overflow-y-auto p-2">
          {isLoading && channels.length === 0 ? (
            <div className="py-12 text-center">
              <LoadingSpinner />
              <p className="text-sm text-text-muted mt-2">Loading channels...</p>
            </div>
          ) : error ? (
            <div className="py-12 text-center">
              <ErrorIcon />
              <p className="text-sm text-error mt-2">{error}</p>
              <button
                onClick={refresh}
                className="mt-3 px-4 py-2 text-sm text-accent-cyan hover:underline"
              >
                Try again
              </button>
            </div>
          ) : channels.length === 0 ? (
            <div className="py-12 text-center">
              <EmptyIcon />
              <p className="text-sm text-text-muted mt-2">
                {searchQuery
                  ? `No channels matching "${searchQuery}"`
                  : 'No channels available'}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {channels.map((channel) => (
                <ChannelCard
                  key={channel.id}
                  channel={channel}
                  isJoining={joiningChannelId === channel.id}
                  isLeaving={leavingChannelId === channel.id}
                  onJoin={() => handleJoin(channel)}
                  onLeave={() => handleLeave(channel)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="p-4 border-t border-sidebar-border">
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={goToPage}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface ChannelCardProps {
  channel: BrowseChannel;
  isJoining: boolean;
  isLeaving: boolean;
  onJoin: () => void;
  onLeave: () => void;
}

function ChannelCard({ channel, isJoining, isLeaving, onJoin, onLeave }: ChannelCardProps) {
  const isProcessing = isJoining || isLeaving;

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-sidebar-border/50 transition-colors">
      {/* Channel icon */}
      <div className={`
        w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0
        ${channel.isPrivate
          ? 'bg-warning/10 text-warning border border-warning/20'
          : 'bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20'
        }
      `}>
        {channel.isPrivate ? <LockIcon /> : <HashIcon />}
      </div>

      {/* Channel info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">
            #{channel.name}
          </span>
          {channel.isPrivate && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-warning/20 text-warning rounded">
              Private
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          {channel.description && (
            <span className="text-xs text-text-muted truncate flex-1">
              {channel.description}
            </span>
          )}
          <span className="text-xs text-text-muted flex-shrink-0">
            {channel.memberCount} member{channel.memberCount !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Action button */}
      {channel.isJoined ? (
        <button
          onClick={onLeave}
          disabled={isProcessing}
          className="px-3 py-1.5 text-xs font-medium text-text-muted border border-sidebar-border rounded-md hover:text-error hover:border-error/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isLeaving ? (
            <span className="flex items-center gap-1">
              <MiniSpinner />
              Leaving...
            </span>
          ) : (
            'Leave'
          )}
        </button>
      ) : (
        <button
          onClick={onJoin}
          disabled={isProcessing}
          className="px-3 py-1.5 text-xs font-medium bg-accent-cyan text-bg-deep rounded-md hover:bg-accent-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isJoining ? (
            <span className="flex items-center gap-1">
              <MiniSpinner />
              Joining...
            </span>
          ) : (
            'Join'
          )}
        </button>
      )}
    </div>
  );
}

// Icons
function HashIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function CloseIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <svg className="animate-spin mx-auto text-accent-cyan" width="24" height="24" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="32"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MiniSpinner() {
  return (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24">
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="32"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="mx-auto text-error" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function EmptyIcon() {
  return (
    <svg className="mx-auto text-text-muted" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="15" x2="16" y2="15" strokeLinecap="round" />
      <circle cx="9" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
