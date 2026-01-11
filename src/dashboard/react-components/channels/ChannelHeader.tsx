/**
 * ChannelHeader Component
 *
 * Displays channel information and provides quick actions.
 * Shows channel name, description, member count, and action buttons.
 */

import React, { useState } from 'react';
import type { Channel, ChannelMember, ChannelHeaderProps } from './types';

export function ChannelHeader({
  channel,
  members = [],
  canEdit = false,
  onEditChannel,
  onShowMembers,
  onShowPinned,
  onSearch,
}: ChannelHeaderProps) {
  const [showDetails, setShowDetails] = useState(false);

  const isDm = channel.isDm;
  const displayName = isDm ? channel.name : `#${channel.name}`;
  const onlineCount = members.filter(m => m.status === 'online').length;

  return (
    <div className="flex-shrink-0 border-b border-border-subtle bg-bg-primary">
      {/* Main header row */}
      <div className="flex items-center justify-between px-4 py-3">
        {/* Left: Channel info */}
        <div className="flex items-center gap-3 min-w-0">
          {/* Channel icon */}
          <div className={`
            flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center
            ${isDm ? 'bg-purple-500/10' : 'bg-accent-cyan/10'}
          `}>
            {isDm ? (
              <AtIcon className="w-4 h-4 text-purple-400" />
            ) : (
              <HashIcon className="w-4 h-4 text-accent-cyan" />
            )}
          </div>

          {/* Channel name and info */}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-text-primary truncate">
                {displayName}
              </h1>
              {channel.status === 'archived' && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-warning/20 text-warning rounded">
                  Archived
                </span>
              )}
              {channel.visibility === 'private' && !isDm && (
                <LockIcon className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
              )}
            </div>
            {channel.topic && (
              <p className="text-xs text-text-muted truncate mt-0.5">
                {channel.topic}
              </p>
            )}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1">
          {/* Members indicator */}
          <button
            onClick={onShowMembers}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="View members"
          >
            <UsersIcon className="w-4 h-4" />
            <span className="text-xs">
              {channel.memberCount}
              {onlineCount > 0 && (
                <span className="text-success ml-1">({onlineCount} online)</span>
              )}
            </span>
          </button>

          {/* Divider */}
          <div className="w-px h-5 bg-border-subtle mx-1" />

          {/* Search */}
          {onSearch && (
            <button
              onClick={onSearch}
              className="p-2 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Search in channel"
            >
              <SearchIcon className="w-4 h-4" />
            </button>
          )}

          {/* Pinned messages */}
          {onShowPinned && (
            <button
              onClick={onShowPinned}
              className="p-2 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Pinned messages"
            >
              <PinIcon className="w-4 h-4" />
            </button>
          )}

          {/* Channel details toggle */}
          <button
            onClick={() => setShowDetails(!showDetails)}
            className={`p-2 rounded-md transition-colors ${
              showDetails
                ? 'text-accent-cyan bg-accent-cyan/10'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover'
            }`}
            title="Channel details"
          >
            <InfoIcon className="w-4 h-4" />
          </button>

          {/* Settings (if can edit) */}
          {canEdit && onEditChannel && (
            <button
              onClick={onEditChannel}
              className="p-2 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              title="Channel settings"
            >
              <SettingsIcon className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Expanded details panel */}
      {showDetails && (
        <div className="px-4 pb-3 border-t border-border-subtle pt-3 bg-bg-secondary/50">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Description */}
            {channel.description && (
              <div>
                <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                  Description
                </h3>
                <p className="text-sm text-text-secondary">
                  {channel.description}
                </p>
              </div>
            )}

            {/* Created info */}
            <div>
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                Created
              </h3>
              <p className="text-sm text-text-secondary">
                {formatDate(channel.createdAt)} by {channel.createdBy}
              </p>
            </div>

            {/* Members preview */}
            {members.length > 0 && (
              <div className="sm:col-span-2">
                <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
                  Members ({channel.memberCount})
                </h3>
                <div className="flex flex-wrap gap-2">
                  {members.slice(0, 10).map(member => (
                    <MemberChip key={member.id} member={member} />
                  ))}
                  {channel.memberCount > 10 && (
                    <button
                      onClick={onShowMembers}
                      className="text-xs text-accent-cyan hover:underline"
                    >
                      +{channel.memberCount - 10} more
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function MemberChip({ member }: { member: ChannelMember }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 bg-bg-tertiary rounded-full text-sm">
      {member.avatarUrl ? (
        <img
          src={member.avatarUrl}
          alt={member.displayName || member.id}
          className="w-4 h-4 rounded-full object-cover"
        />
      ) : (
        <div className={`
          w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-medium
          ${member.entityType === 'user'
            ? 'bg-purple-500/30 text-purple-300'
            : 'bg-accent-cyan/30 text-accent-cyan'}
        `}>
          {(member.displayName || member.id).charAt(0).toUpperCase()}
        </div>
      )}
      <span className="text-text-secondary truncate max-w-[100px]">
        {member.displayName || member.id}
      </span>
      <span className={`w-1.5 h-1.5 rounded-full ${
        member.status === 'online' ? 'bg-success' :
        member.status === 'away' ? 'bg-warning' : 'bg-text-dim'
      }`} />
    </div>
  );
}

// =============================================================================
// Helper functions
// =============================================================================

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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

function LockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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

function PinIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export default ChannelHeader;
