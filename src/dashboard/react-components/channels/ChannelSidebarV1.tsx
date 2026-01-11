/**
 * ChannelSidebarV1 Component
 *
 * Enhanced channel sidebar with search, unread badges, archived section,
 * and create channel functionality. Uses Tailwind CSS for styling.
 */

import React, { useState, useCallback, useMemo } from 'react';
import type { Channel, ChannelSidebarV1Props } from './types';

const ARCHIVED_COLLAPSED_KEY = 'channels-v1-archived-collapsed';

export function ChannelSidebarV1({
  channels,
  archivedChannels = [],
  selectedChannelId,
  isConnected,
  isLoading,
  onSelectChannel,
  onCreateChannel,
  onJoinChannel,
  onLeaveChannel,
  onArchiveChannel,
  onUnarchiveChannel,
  currentUser,
}: ChannelSidebarV1Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [isArchivedCollapsed, setIsArchivedCollapsed] = useState(() => {
    try {
      return localStorage.getItem(ARCHIVED_COLLAPSED_KEY) === 'true';
    } catch {
      return true;
    }
  });

  // Persist archived collapsed state
  const toggleArchivedCollapsed = useCallback(() => {
    setIsArchivedCollapsed(prev => {
      const newValue = !prev;
      try {
        localStorage.setItem(ARCHIVED_COLLAPSED_KEY, String(newValue));
      } catch {
        // localStorage not available
      }
      return newValue;
    });
  }, []);

  // Separate public channels and DMs, filter by search
  const { publicChannels, dmChannels } = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const filtered = channels.filter(c =>
      c.name.toLowerCase().includes(query) ||
      c.description?.toLowerCase().includes(query)
    );

    return {
      publicChannels: filtered.filter(c => !c.isDm).sort((a, b) => a.name.localeCompare(b.name)),
      dmChannels: filtered.filter(c => c.isDm).sort((a, b) => {
        // Sort DMs by last activity
        const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        return bTime - aTime;
      }),
    };
  }, [channels, searchQuery]);

  // Filter archived channels
  const filteredArchived = useMemo(() => {
    if (!searchQuery) return archivedChannels;
    const query = searchQuery.toLowerCase();
    return archivedChannels.filter(c =>
      c.name.toLowerCase().includes(query) ||
      c.description?.toLowerCase().includes(query)
    );
  }, [archivedChannels, searchQuery]);

  // Total unread count for badge
  const totalUnread = useMemo(() =>
    channels.reduce((sum, c) => sum + c.unreadCount, 0),
    [channels]
  );

  // Get display name for DM channels
  const getDmDisplayName = useCallback((channel: Channel) => {
    if (!channel.dmParticipants || !currentUser) {
      return channel.name;
    }
    const otherParticipants = channel.dmParticipants.filter(p => p !== currentUser);
    return otherParticipants.join(', ') || channel.name;
  }, [currentUser]);

  return (
    <div className="flex flex-col h-full bg-bg-secondary border-r border-border-subtle">
      {/* Header */}
      <div className="p-3 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <HashIcon className="w-5 h-5 text-accent-cyan" />
            <h2 className="text-sm font-semibold text-text-primary">Channels</h2>
            {totalUnread > 0 && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-accent-cyan/20 text-accent-cyan">
                {totalUnread > 99 ? '99+' : totalUnread}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ConnectionIndicator isConnected={isConnected} />
            <button
              onClick={onCreateChannel}
              className="p-1.5 rounded-md bg-bg-tertiary border border-border-subtle text-text-muted hover:text-accent-cyan hover:border-accent-cyan/30 transition-colors"
              title="Create channel"
            >
              <PlusIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 py-2 px-2.5 bg-bg-tertiary rounded-lg border border-border-subtle focus-within:border-accent-cyan/50 transition-colors">
          <SearchIcon className="w-4 h-4 text-text-muted flex-shrink-0" />
          <input
            type="text"
            placeholder="Search channels..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent border-none text-text-primary text-sm outline-none placeholder:text-text-muted min-w-0"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="p-0.5 text-text-muted hover:text-text-secondary transition-colors"
            >
              <ClearIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Channel List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <LoadingSpinner />
          </div>
        ) : (
          <>
            {/* Public Channels Section */}
            <div className="py-2">
              <SectionHeader title="Channels" count={publicChannels.length} />
              {publicChannels.length === 0 ? (
                <EmptyState
                  message={searchQuery ? 'No channels match your search' : 'No channels yet'}
                  action={searchQuery ? undefined : { label: 'Create one', onClick: onCreateChannel }}
                />
              ) : (
                <div className="space-y-0.5 px-2">
                  {publicChannels.map(channel => (
                    <ChannelItem
                      key={channel.id}
                      channel={channel}
                      isSelected={selectedChannelId === channel.id}
                      onSelect={() => onSelectChannel(channel)}
                      onLeave={() => onLeaveChannel(channel)}
                      onArchive={() => onArchiveChannel(channel)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Direct Messages Section */}
            {dmChannels.length > 0 && (
              <div className="py-2 border-t border-border-subtle">
                <SectionHeader title="Direct Messages" count={dmChannels.length} />
                <div className="space-y-0.5 px-2">
                  {dmChannels.map(channel => (
                    <ChannelItem
                      key={channel.id}
                      channel={channel}
                      displayName={getDmDisplayName(channel)}
                      isSelected={selectedChannelId === channel.id}
                      onSelect={() => onSelectChannel(channel)}
                      onLeave={() => onLeaveChannel(channel)}
                      isDm
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Archived Section */}
            {filteredArchived.length > 0 && (
              <div className="py-2 border-t border-border-subtle">
                <button
                  onClick={toggleArchivedCollapsed}
                  className="flex items-center justify-between w-full px-3 py-1.5 text-xs font-semibold text-text-muted uppercase tracking-wide hover:text-text-secondary transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <ArchiveIcon className="w-3.5 h-3.5" />
                    Archived
                    <span className="text-[10px] opacity-70">({filteredArchived.length})</span>
                  </span>
                  <ChevronIcon
                    className={`w-4 h-4 transition-transform ${isArchivedCollapsed ? '' : 'rotate-180'}`}
                  />
                </button>
                {!isArchivedCollapsed && (
                  <div className="space-y-0.5 px-2 mt-1">
                    {filteredArchived.map(channel => (
                      <ChannelItem
                        key={channel.id}
                        channel={channel}
                        isSelected={selectedChannelId === channel.id}
                        onSelect={() => onSelectChannel(channel)}
                        onUnarchive={() => onUnarchiveChannel(channel)}
                        isArchived
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer - Browse/Join channels */}
      <div className="p-3 border-t border-border-subtle">
        <button
          onClick={() => setShowCreateModal(true)}
          className="w-full py-2 px-3 text-sm text-text-secondary bg-bg-tertiary rounded-lg border border-border-subtle hover:bg-bg-hover hover:text-text-primary transition-colors flex items-center justify-center gap-2"
        >
          <BrowseIcon className="w-4 h-4" />
          Browse channels
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

interface ChannelItemProps {
  channel: Channel;
  displayName?: string;
  isSelected: boolean;
  onSelect: () => void;
  onLeave?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  isDm?: boolean;
  isArchived?: boolean;
}

function ChannelItem({
  channel,
  displayName,
  isSelected,
  onSelect,
  onLeave,
  onArchive,
  onUnarchive,
  isDm,
  isArchived,
}: ChannelItemProps) {
  const [showMenu, setShowMenu] = useState(false);

  const hasUnread = channel.unreadCount > 0;
  const name = displayName || channel.name;

  return (
    <div
      className="relative group"
      onMouseLeave={() => setShowMenu(false)}
    >
      <button
        onClick={onSelect}
        className={`
          w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-all duration-150
          ${isSelected
            ? 'bg-accent-cyan/10 text-text-primary'
            : 'hover:bg-bg-hover text-text-secondary hover:text-text-primary'}
          ${isArchived ? 'opacity-60' : ''}
        `}
      >
        {/* Icon */}
        <span className={`flex-shrink-0 ${hasUnread ? 'text-text-primary' : 'text-text-muted'}`}>
          {isDm ? <AtIcon className="w-4 h-4" /> : <HashIcon className="w-4 h-4" />}
        </span>

        {/* Name */}
        <span
          className={`flex-1 truncate text-sm ${hasUnread ? 'font-semibold text-text-primary' : ''}`}
        >
          {name}
        </span>

        {/* Unread Badge */}
        {hasUnread && (
          <span
            className={`
              flex-shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center
              ${channel.hasMentions
                ? 'bg-red-500/20 text-red-400'
                : 'bg-accent-cyan/20 text-accent-cyan'}
            `}
          >
            {channel.unreadCount > 99 ? '99+' : channel.unreadCount}
          </span>
        )}

        {/* More menu button (visible on hover) */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu(!showMenu);
          }}
          className="flex-shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-bg-tertiary transition-opacity"
        >
          <MoreIcon className="w-3.5 h-3.5 text-text-muted" />
        </button>
      </button>

      {/* Dropdown Menu */}
      {showMenu && (
        <div className="absolute right-2 top-full mt-1 z-20 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg py-1 min-w-[140px]">
          {isArchived ? (
            <MenuItem onClick={() => { onUnarchive?.(); setShowMenu(false); }}>
              <UnarchiveIcon className="w-4 h-4" />
              Unarchive
            </MenuItem>
          ) : (
            <>
              {onLeave && (
                <MenuItem onClick={() => { onLeave(); setShowMenu(false); }}>
                  <LeaveIcon className="w-4 h-4" />
                  Leave channel
                </MenuItem>
              )}
              {onArchive && !isDm && (
                <MenuItem onClick={() => { onArchive(); setShowMenu(false); }}>
                  <ArchiveIcon className="w-4 h-4" />
                  Archive
                </MenuItem>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
    >
      {children}
    </button>
  );
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center justify-between px-3 py-1.5">
      <span className="text-xs font-semibold text-text-muted uppercase tracking-wide">
        {title}
      </span>
      {count !== undefined && (
        <span className="text-[10px] text-text-muted">
          {count}
        </span>
      )}
    </div>
  );
}

function ConnectionIndicator({ isConnected }: { isConnected: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <div
        className={`w-2 h-2 rounded-full ${
          isConnected ? 'bg-success animate-pulse' : 'bg-text-dim'
        }`}
      />
    </div>
  );
}

function EmptyState({
  message,
  action
}: {
  message: string;
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="px-3 py-4 text-center">
      <p className="text-sm text-text-muted">{message}</p>
      {action && (
        <button
          onClick={action.onClick}
          className="mt-2 text-sm text-accent-cyan hover:underline"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="w-5 h-5 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
  );
}

// =============================================================================
// Icons
// =============================================================================

function HashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

function AtIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94" />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ClearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}

function UnarchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8" />
      <rect x="1" y="3" width="22" height="5" />
      <path d="M12 12v6" />
      <path d="M9 15l3-3 3 3" />
    </svg>
  );
}

function MoreIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}

function LeaveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function BrowseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

export default ChannelSidebarV1;
