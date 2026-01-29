/**
 * TypingIndicator Component
 *
 * Shows animated typing indicator when other users are typing.
 * Displays user avatars and "X is typing..." text.
 */

import React from 'react';
import type { TypingIndicator as TypingIndicatorType } from './hooks/usePresence';

export interface TypingIndicatorProps {
  /** List of users currently typing */
  typingUsers: TypingIndicatorType[];
}

export function TypingIndicator({ typingUsers }: TypingIndicatorProps) {
  if (typingUsers.length === 0) {
    return null;
  }

  // Format the typing text
  const formatTypingText = () => {
    if (typingUsers.length === 1) {
      return `${typingUsers[0].username} is typing`;
    } else if (typingUsers.length === 2) {
      return `${typingUsers[0].username} and ${typingUsers[1].username} are typing`;
    } else {
      return `${typingUsers[0].username} and ${typingUsers.length - 1} others are typing`;
    }
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-sm text-[#8d8d8e]">
      {/* Avatars */}
      <div className="flex -space-x-1.5">
        {typingUsers.slice(0, 3).map((user) => (
          <div
            key={user.username}
            className="relative"
            title={user.username}
          >
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.username}
                className="w-5 h-5 rounded-full border border-[#1a1d21]"
              />
            ) : (
              <div className="w-5 h-5 rounded-full bg-[#a855f7] border border-[#1a1d21] flex items-center justify-center text-[9px] text-white font-medium">
                {user.username.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Typing text */}
      <span className="flex items-center gap-1">
        {formatTypingText()}
        {/* Animated dots */}
        <span className="flex gap-0.5">
          <span className="w-1 h-1 bg-[#8d8d8e] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1 h-1 bg-[#8d8d8e] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1 h-1 bg-[#8d8d8e] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </span>
      </span>
    </div>
  );
}
