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

import React, { useCallback, useMemo } from 'react';
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
  onSendMessage: (content: string) => void;
  /** Callback when editing channel settings */
  onEditChannel?: () => void;
  /** Callback to show member list */
  onShowMembers?: () => void;
  /** Callback to show pinned messages */
  onShowPinned?: () => void;
  /** Callback to search in channel */
  onSearch?: () => void;
  /** Callback when clicking thread button */
  onThreadClick?: (messageId: string) => void;
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
  onThreadClick,
  onTyping,
  onMarkRead,
  onMemberClick,
}: ChannelViewV1Props) {
  // Handle send
  const handleSend = useCallback((content: string) => {
    onSendMessage(content);
  }, [onSendMessage]);

  // Get placeholder text based on channel type
  const inputPlaceholder = useMemo(() => {
    if (channel.isDm) {
      return `Message ${channel.name}`;
    }
    return `Message #${channel.name}`;
  }, [channel]);

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
        onThreadClick={onThreadClick}
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
          placeholder={inputPlaceholder}
          onSend={handleSend}
          onTyping={onTyping}
          mentionSuggestions={mentionSuggestions}
        />
      )}
    </div>
  );
}

export default ChannelViewV1;
