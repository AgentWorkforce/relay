/**
 * UserProfilePanel Component
 *
 * Slide-out panel showing user profile details.
 * Displays avatar, username, GitHub link, and action buttons.
 */

import React, { useEffect, useRef } from 'react';
import type { UserPresence } from './hooks/usePresence';

export interface UserProfilePanelProps {
  /** User to display (null to hide panel) */
  user: UserPresence | null;
  /** Callback when panel should close */
  onClose: () => void;
  /** Callback when mention button is clicked */
  onMention?: (username: string) => void;
}

export function UserProfilePanel({ user, onClose, onMention }: UserProfilePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (user) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [user, onClose]);

  // Close on outside click
  // Use a ref to track if the panel just opened to avoid closing on the same click
  const justOpenedRef = useRef(false);

  useEffect(() => {
    if (user) {
      // Mark as just opened
      justOpenedRef.current = true;
    }
  }, [user]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Skip if panel just opened (same event loop tick that opened it)
      if (justOpenedRef.current) {
        justOpenedRef.current = false;
        return;
      }

      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    if (user) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [user, onClose]);

  if (!user) {
    return null;
  }

  const githubUrl = `https://github.com/${user.username}`;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="fixed right-0 top-0 h-full w-80 bg-[#1a1d21] border-l border-white/10 shadow-2xl z-50 flex flex-col animate-slide-in-right"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-[#d1d2d3]">Profile</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/10 rounded-md transition-colors"
            title="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* User Info */}
        <div className="flex flex-col items-center p-6 border-b border-white/10">
          {/* Large Avatar */}
          <div className="relative mb-4">
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.username}
                className="w-24 h-24 rounded-full object-cover border-4 border-[#a855f7]/30"
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-[#a855f7] flex items-center justify-center text-3xl text-white font-bold border-4 border-[#a855f7]/30">
                {user.username.charAt(0).toUpperCase()}
              </div>
            )}
            {/* Online indicator */}
            <div className="absolute bottom-1 right-1 w-5 h-5 bg-green-500 rounded-full border-4 border-[#1a1d21]" />
          </div>

          {/* Username */}
          <h3 className="text-xl font-semibold text-[#d1d2d3] mb-1">
            {user.username}
          </h3>

          {/* Status */}
          <span className="text-sm text-green-400 flex items-center gap-1.5">
            <div className="w-2 h-2 bg-green-500 rounded-full" />
            Online
          </span>
        </div>

        {/* Details */}
        <div className="flex-1 p-4 overflow-y-auto">
          <div className="space-y-4">
            {/* Online Since */}
            <div>
              <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Online Since</label>
              <p className="text-sm text-[#d1d2d3] mt-1">
                {formatDateTime(user.connectedAt)}
              </p>
            </div>

            {/* Last Active */}
            <div>
              <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">Last Active</label>
              <p className="text-sm text-[#d1d2d3] mt-1">
                {formatDateTime(user.lastSeen)}
              </p>
            </div>

            {/* GitHub Link */}
            <div>
              <label className="text-xs text-[#8d8d8e] uppercase tracking-wide">GitHub</label>
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 mt-1 text-sm text-[#a855f7] hover:text-[#c084fc] transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                @{user.username}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                </svg>
              </a>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="p-4 border-t border-white/10 space-y-2">
          {/* Mention Button */}
          <button
            onClick={() => {
              onMention?.(user.username);
              onClose();
            }}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#a855f7] hover:bg-[#9333ea] text-white font-medium rounded-lg transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="4" />
              <path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94" />
            </svg>
            Mention @{user.username}
          </button>

          {/* View on GitHub */}
          <a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-center gap-2 py-2.5 border border-white/20 text-[#d1d2d3] hover:bg-white/5 font-medium rounded-lg transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            View on GitHub
          </a>
        </div>
      </div>
    </>
  );
}

/**
 * Format a timestamp to a readable date/time
 */
function formatDateTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
