/**
 * OnlineUsersIndicator Component
 *
 * Shows a row of avatars for online users with a count indicator.
 * Clicking reveals a dropdown list with all online users.
 */

import React, { useState, useRef, useEffect } from 'react';
import type { UserPresence } from './hooks/usePresence';

export interface OnlineUsersIndicatorProps {
  /** List of online users */
  onlineUsers: UserPresence[];
  /** Callback when a user is clicked (for profile viewing) */
  onUserClick?: (user: UserPresence) => void;
  /** Maximum avatars to show before "+N" */
  maxAvatars?: number;
}

export function OnlineUsersIndicator({
  onlineUsers,
  onUserClick,
  maxAvatars = 4,
}: OnlineUsersIndicatorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  if (onlineUsers.length === 0) {
    return null;
  }

  const displayedUsers = onlineUsers.slice(0, maxAvatars);
  const remainingCount = Math.max(0, onlineUsers.length - maxAvatars);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Compact avatar row */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/[0.05] transition-colors"
        title={`${onlineUsers.length} user${onlineUsers.length !== 1 ? 's' : ''} online`}
      >
        {/* Green online indicator */}
        <div className="w-2 h-2 bg-green-500 rounded-full" />

        {/* Stacked avatars */}
        <div className="flex -space-x-1.5">
          {displayedUsers.map((user) => (
            <div
              key={user.username}
              className="relative ring-2 ring-[#1a1d21] rounded-full"
              title={user.username}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.username}
                  className="w-6 h-6 rounded-full object-cover"
                />
              ) : (
                <div className="w-6 h-6 rounded-full bg-[#a855f7] flex items-center justify-center text-[10px] text-white font-medium">
                  {user.username.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
          ))}
          {remainingCount > 0 && (
            <div className="w-6 h-6 rounded-full bg-[#3d4043] ring-2 ring-[#1a1d21] flex items-center justify-center text-[10px] text-[#d1d2d3] font-medium">
              +{remainingCount}
            </div>
          )}
        </div>

        {/* Count text */}
        <span className="text-xs text-[#8d8d8e]">
          {onlineUsers.length} online
        </span>
      </button>

      {/* Dropdown list */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-[#1a1d21] border border-white/10 rounded-lg shadow-xl z-50 max-h-[300px] overflow-y-auto">
          <div className="p-2 border-b border-white/10">
            <h3 className="text-sm font-medium text-[#d1d2d3]">Online Users</h3>
          </div>
          <div className="py-1">
            {onlineUsers.map((user) => (
              <button
                key={user.username}
                onClick={() => {
                  onUserClick?.(user);
                  setIsOpen(false);
                }}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-white/[0.05] transition-colors text-left"
              >
                {/* Avatar with online indicator */}
                <div className="relative">
                  {user.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt={user.username}
                      className="w-8 h-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-[#a855f7] flex items-center justify-center text-xs text-white font-medium">
                      {user.username.charAt(0).toUpperCase()}
                    </div>
                  )}
                  {/* Green online dot */}
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-[#1a1d21]" />
                </div>

                {/* User info */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[#d1d2d3] truncate">
                    {user.username}
                  </div>
                  <div className="text-xs text-[#8d8d8e]">
                    Online since {formatTime(user.connectedAt)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Format a timestamp to a readable time
 */
function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();

  // If same day, show time only
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Otherwise show date and time
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
