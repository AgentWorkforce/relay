/**
 * MessageSenderName Component
 *
 * Clickable sender name for chat messages.
 * Opens agent profile panel for agents, user profile panel for humans.
 * Maintains existing color styling while adding hover feedback.
 */

import React, { useCallback } from 'react';
import type { Agent } from '../types';
import type { UserPresence } from './hooks/usePresence';

export interface MessageSenderNameProps {
  /** Display name to show */
  displayName: string;
  /** Color for the name text */
  color: string;
  /** Whether this sender is the current user */
  isCurrentUser?: boolean;
  /** Agent object if sender is an agent */
  agent?: Agent;
  /** User presence object if sender is a human user */
  userPresence?: UserPresence;
  /** Callback when an agent name is clicked */
  onAgentClick?: (agent: Agent) => void;
  /** Callback when a human user name is clicked */
  onUserClick?: (user: UserPresence) => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Clickable sender name component for chat messages.
 * Provides visual feedback on hover and opens the appropriate profile panel on click.
 */
export function MessageSenderName({
  displayName,
  color,
  isCurrentUser = false,
  agent,
  userPresence,
  onAgentClick,
  onUserClick,
  className = '',
}: MessageSenderNameProps) {
  const handleClick = useCallback(() => {
    if (agent && onAgentClick) {
      onAgentClick(agent);
    } else if (userPresence && onUserClick) {
      onUserClick(userPresence);
    }
  }, [agent, userPresence, onAgentClick, onUserClick]);

  // Determine if the name should be clickable
  const isClickable = (agent && onAgentClick) || (userPresence && onUserClick);

  // If not clickable, render as plain text
  if (!isClickable) {
    return (
      <span
        className={`font-display font-semibold text-sm ${className}`}
        style={{ color }}
      >
        {displayName}
      </span>
    );
  }

  // Render as interactive button
  return (
    <button
      type="button"
      onClick={handleClick}
      className={`
        font-display font-semibold text-sm
        bg-transparent border-none p-0 m-0
        cursor-pointer
        transition-all duration-150
        hover:underline hover:decoration-current hover:decoration-1 hover:underline-offset-2
        focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-accent-cyan/50 focus:rounded-sm
        ${className}
      `}
      style={{ color }}
      title={`View ${agent ? 'agent' : 'user'} profile: ${displayName}`}
    >
      {displayName}
    </button>
  );
}

export default MessageSenderName;
