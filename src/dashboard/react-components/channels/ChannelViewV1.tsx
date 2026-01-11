/**
 * ChannelViewV1 Component
 *
 * Composed channel view that combines:
 * - ChannelHeader
 * - ChannelMessageList
 * - MessageInput
 *
 * This is the main view component for displaying a channel's content.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { ChannelHeader } from './ChannelHeader';
import { ChannelMessageList } from './ChannelMessageList';
import { MessageInput } from './MessageInput';
import type {
  Channel,
  ChannelMember,
  ChannelMessage,
  UnreadState,
} from './types';

export interface ChannelViewV1Props {
  /** Current channel to display */
  channel: Channel;
  /** Channel members */
  members?: ChannelMember[];
  /** Messages in the channel */
  messages: ChannelMessage[];
  /** Unread state for the channel */
  unreadState?: UnreadState;
  /** Current user's name */
  currentUser: string;
  /** Whether user can edit the channel */
  canEditChannel?: boolean;
  /** Whether loading more messages */
  isLoadingMore?: boolean;
  /** Whether there are more messages to load */
  hasMoreMessages?: boolean;
  /** Available users/agents for @-mentions */
  mentionSuggestions?: string[];
  /** Callback to load more messages */
  onLoadMore?: () => void;
  /** Callback to send a message */
  onSendMessage: (content: string, threadId?: string) => void;
  /** Callback when editing channel settings */
  onEditChannel?: () => void;
  /** Callback to show member list */
  onShowMembers?: () => void;
  /** Callback to show pinned messages */
  onShowPinned?: () => void;
  /** Callback to search in channel */
  onSearch?: () => void;
  /** Callback when replying to a message (starts thread) */
  onReply?: (message: ChannelMessage) => void;
  /** Callback when reacting to a message */
  onReact?: (message: ChannelMessage, emoji: string) => void;
  /** Callback when typing status changes */
  onTyping?: (isTyping: boolean) => void;
  /** Callback to mark messages as read */
  onMarkRead?: (upToTimestamp: string) => void;
  /** Callback when clicking on a member name (for DM navigation) */
  onMemberClick?: (memberId: string, entityType: 'user' | 'agent') => void;
}

export function ChannelViewV1({
  channel,
  members = [],
  messages,
  unreadState,
  currentUser,
  canEditChannel = false,
  isLoadingMore = false,
  hasMoreMessages = false,
  mentionSuggestions = [],
  onLoadMore,
  onSendMessage,
  onEditChannel,
  onShowMembers,
  onShowPinned,
  onSearch,
  onReply,
  onReact,
  onTyping,
  onMarkRead,
  onMemberClick,
}: ChannelViewV1Props) {
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [replyingToThread, setReplyingToThread] = useState<string | undefined>();

  // Toggle thread expansion
  const handleToggleThread = useCallback((messageId: string) => {
    setExpandedThreads(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  // Handle reply - expands thread and sets reply context
  const handleReply = useCallback((message: ChannelMessage) => {
    setReplyingToThread(message.id);
    setExpandedThreads(prev => new Set(prev).add(message.id));
    onReply?.(message);
  }, [onReply]);

  // Handle send - includes thread context
  const handleSend = useCallback((content: string) => {
    onSendMessage(content, replyingToThread);
    // Keep thread context for subsequent messages unless user clears it
  }, [onSendMessage, replyingToThread]);

  // Cancel thread reply
  const handleCancelThread = useCallback(() => {
    setReplyingToThread(undefined);
  }, []);

  // Mark channel as read when messages load
  // (This would typically be called when component mounts or channel changes)

  // Get placeholder text based on channel type
  const inputPlaceholder = useMemo(() => {
    if (replyingToThread) {
      return 'Reply in thread...';
    }
    if (channel.isDm) {
      return `Message ${channel.name}`;
    }
    return `Message #${channel.name}`;
  }, [channel, replyingToThread]);

  // Check if channel is archived (disable input)
  const isArchived = channel.status === 'archived';

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      {/* Header */}
      <ChannelHeader
        channel={channel}
        members={members}
        canEdit={canEditChannel}
        onEditChannel={onEditChannel}
        onShowMembers={onShowMembers}
        onShowPinned={onShowPinned}
        onSearch={onSearch}
      />

      {/* Message List */}
      <ChannelMessageList
        messages={messages}
        unreadState={unreadState}
        currentUser={currentUser}
        isLoadingMore={isLoadingMore}
        hasMore={hasMoreMessages}
        onLoadMore={onLoadMore}
        onToggleThread={handleToggleThread}
        expandedThreads={expandedThreads}
        onReply={handleReply}
        onReact={onReact}
        onMemberClick={onMemberClick}
      />

      {/* Message Input */}
      {isArchived ? (
        <div className="px-4 py-3 bg-bg-secondary border-t border-border-subtle text-center">
          <p className="text-sm text-text-muted">
            This channel is archived. Unarchive it to send messages.
          </p>
        </div>
      ) : (
        <MessageInput
          channelId={channel.id}
          threadId={replyingToThread}
          placeholder={inputPlaceholder}
          onSend={handleSend}
          onTyping={onTyping}
          mentionSuggestions={mentionSuggestions}
        />
      )}
    </div>
  );
}

// =============================================================================
// Icons
// =============================================================================

function ThreadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 9h8" />
      <path d="M8 13h6" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default ChannelViewV1;
