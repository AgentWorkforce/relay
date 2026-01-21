/**
 * ChannelMessageList Component
 *
 * Displays messages in a channel with:
 * - Unread separator
 * - Date dividers
 * - Auto-scroll to new messages
 * - Infinite scroll for history
 */

import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type { ChannelMessage, ChannelMessageListProps, UnreadState } from './types';
import { formatMessageBody } from '../utils/messageFormatting';

export function ChannelMessageList({
  messages,
  unreadState,
  currentUser,
  isLoadingMore = false,
  hasMore = false,
  onLoadMore,
  onThreadClick,
  onMemberClick,
}: ChannelMessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Group messages by date
  const groupedMessages = useMemo(() => {
    const groups: { date: string; messages: ChannelMessage[] }[] = [];
    let currentDate = '';

    messages.forEach(message => {
      const messageDate = formatDateKey(message.timestamp);
      if (messageDate !== currentDate) {
        currentDate = messageDate;
        groups.push({ date: messageDate, messages: [message] });
      } else {
        groups[groups.length - 1].messages.push(message);
      }
    });

    return groups;
  }, [messages]);

  // Handle scroll events
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom < 100;

    setIsNearBottom(nearBottom);
    setShowScrollToBottom(!nearBottom && distanceFromBottom > 500);

    // Load more when scrolling near top
    if (scrollTop < 100 && hasMore && !isLoadingMore && onLoadMore) {
      onLoadMore();
    }
  }, [hasMore, isLoadingMore, onLoadMore]);

  // Scroll to bottom when new messages arrive (if near bottom)
  useEffect(() => {
    if (isNearBottom && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, isNearBottom]);

  // Initial scroll to bottom
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView();
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-2"
      >
        {/* Loading more indicator */}
        {isLoadingMore && (
          <div className="flex justify-center py-4">
            <LoadingSpinner />
          </div>
        )}

        {/* Load more button */}
        {hasMore && !isLoadingMore && (
          <div className="flex justify-center py-4">
            <button
              onClick={onLoadMore}
              className="text-sm text-accent-cyan hover:underline"
            >
              Load earlier messages
            </button>
          </div>
        )}

        {/* Empty state */}
        {messages.length === 0 && !isLoadingMore && (
          <div className="flex flex-col items-center justify-center h-full text-center py-12">
            <div className="text-4xl mb-3">
              <MessageIcon className="w-12 h-12 text-text-muted" />
            </div>
            <h3 className="text-lg font-medium text-text-primary mb-1">
              No messages yet
            </h3>
            <p className="text-sm text-text-muted">
              Be the first to send a message in this channel
            </p>
          </div>
        )}

        {/* Message groups */}
        {groupedMessages.map(({ date, messages: dateMessages }) => (
          <div key={date}>
            {/* Date divider */}
            <DateDivider date={date} />

            {/* Messages for this date */}
            {dateMessages.map((message, index) => {
              const isFirstUnread = unreadState?.firstUnreadMessageId === message.id;
              const showUnreadSeparator = isFirstUnread && unreadState && unreadState.count > 0;

              return (
                <React.Fragment key={message.id}>
                  {/* Unread separator */}
                  {showUnreadSeparator && (
                    <UnreadSeparator count={unreadState.count} />
                  )}

                  {/* Message */}
                  <MessageItem
                    message={message}
                    isOwn={message.from === currentUser}
                    onThreadClick={onThreadClick}
                    onMemberClick={onMemberClick}
                    showAvatar={shouldShowAvatar(dateMessages, index)}
                  />
                </React.Fragment>
              );
            })}
          </div>
        ))}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom button */}
      {showScrollToBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 p-3 bg-bg-elevated border border-border-subtle rounded-full shadow-lg hover:bg-bg-hover transition-colors"
          title="Scroll to bottom"
        >
          <ChevronDownIcon className="w-5 h-5 text-text-primary" />
        </button>
      )}
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

interface MessageItemProps {
  message: ChannelMessage;
  isOwn: boolean;
  onThreadClick?: (messageId: string) => void;
  onMemberClick?: (memberId: string, entityType: 'user' | 'agent') => void;
  showAvatar: boolean;
}

function MessageItem({
  message,
  isOwn,
  onThreadClick,
  onMemberClick,
  showAvatar,
}: MessageItemProps) {
  const hasThread = message.threadSummary && message.threadSummary.replyCount > 0;

  return (
    <div className={`group relative py-1 ${showAvatar ? 'mt-3' : ''}`}>
      <div className="flex gap-3">
        {/* Avatar column */}
        <div className="w-9 flex-shrink-0">
          {showAvatar && (
            <Avatar
              name={message.from}
              avatarUrl={message.fromAvatarUrl}
              entityType={message.fromEntityType}
            />
          )}
        </div>

        {/* Content column */}
        <div className="flex-1 min-w-0">
          {/* Header (only show with avatar) */}
          {showAvatar && (
            <div className="flex items-center gap-2 mb-0.5">
              <button
                type="button"
                onClick={() => {
                  if (!isOwn && onMemberClick) {
                    onMemberClick(message.from, message.fromEntityType || 'agent');
                  }
                }}
                disabled={isOwn || !onMemberClick}
                className={`text-sm font-semibold ${
                  isOwn ? 'text-accent-cyan cursor-default' : 'text-text-primary hover:underline cursor-pointer'
                } disabled:cursor-default disabled:hover:no-underline`}
              >
                {message.from}
              </button>
              <span className="text-xs text-text-muted">
                {formatTime(message.timestamp)}
              </span>
              {message.editedAt && (
                <span className="text-xs text-text-muted">(edited)</span>
              )}

              {/* Thread button */}
              <button
                className={`
                  inline-flex items-center gap-1.5 p-1.5 rounded-lg transition-all duration-150 cursor-pointer border-none
                  ${hasThread || message.threadId
                    ? 'text-accent-cyan bg-accent-cyan/10 hover:bg-accent-cyan/20'
                    : 'text-text-muted bg-transparent opacity-0 group-hover:opacity-100 hover:text-accent-cyan hover:bg-accent-cyan/10'}
                `}
                onClick={() => onThreadClick?.(message.threadId || message.id)}
                title={message.threadId ? `View thread` : (hasThread ? `${message.threadSummary!.replyCount} ${message.threadSummary!.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread')}
              >
                <ThreadIcon className="w-3.5 h-3.5" />
                {hasThread && (
                  <span className="text-xs font-medium">{message.threadSummary!.replyCount}</span>
                )}
              </button>
            </div>
          )}

          {/* Message content */}
          <div className="text-sm text-text-primary whitespace-pre-wrap break-words">
            {formatMessageBody(message.content, { mentions: message.mentions })}
          </div>

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {message.attachments.map(attachment => (
                <AttachmentPreview key={attachment.id} attachment={attachment} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Avatar({
  name,
  avatarUrl,
  entityType,
}: {
  name: string;
  avatarUrl?: string;
  entityType: 'agent' | 'user';
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        className="w-9 h-9 rounded-full object-cover"
      />
    );
  }

  return (
    <div className={`
      w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium
      ${entityType === 'user'
        ? 'bg-purple-500/30 text-purple-300'
        : 'bg-accent-cyan/30 text-accent-cyan'}
    `}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function AttachmentPreview({ attachment }: { attachment: NonNullable<ChannelMessage['attachments']>[0] }) {
  const isImage = attachment.mimeType.startsWith('image/');

  if (isImage) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block max-w-xs rounded-lg overflow-hidden border border-border-subtle hover:border-accent-cyan/30 transition-colors"
      >
        <img
          src={attachment.thumbnailUrl || attachment.url}
          alt={attachment.filename}
          className="max-w-full max-h-48 object-cover"
        />
      </a>
    );
  }

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 px-3 py-2 bg-bg-tertiary rounded-lg border border-border-subtle hover:border-accent-cyan/30 transition-colors"
    >
      <FileIcon className="w-5 h-5 text-text-muted" />
      <div className="min-w-0">
        <p className="text-sm text-text-primary truncate">{attachment.filename}</p>
        <p className="text-xs text-text-muted">{formatFileSize(attachment.size)}</p>
      </div>
    </a>
  );
}

function DateDivider({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1 h-px bg-border-subtle" />
      <span className="text-xs font-medium text-text-muted px-2">
        {formatDateDisplay(date)}
      </span>
      <div className="flex-1 h-px bg-border-subtle" />
    </div>
  );
}

function UnreadSeparator({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-3 py-2 my-2">
      <div className="flex-1 h-px bg-red-500/50" />
      <span className="text-xs font-semibold text-red-400 px-2 flex items-center gap-1">
        <span className="w-2 h-2 bg-red-500 rounded-full" />
        {count} new {count === 1 ? 'message' : 'messages'}
      </span>
      <div className="flex-1 h-px bg-red-500/50" />
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="w-5 h-5 border-2 border-accent-cyan/30 border-t-accent-cyan rounded-full animate-spin" />
  );
}

// =============================================================================
// Helper functions
// =============================================================================

function shouldShowAvatar(messages: ChannelMessage[], index: number): boolean {
  if (index === 0) return true;
  const current = messages[index];
  const previous = messages[index - 1];

  // Show avatar if different sender
  if (current.from !== previous.from) return true;

  // Show avatar if more than 5 minutes since last message
  const currentTime = new Date(current.timestamp).getTime();
  const previousTime = new Date(previous.timestamp).getTime();
  return currentTime - previousTime > 5 * 60 * 1000;
}

function formatDateKey(isoString: string): string {
  return new Date(isoString).toDateString();
}

function formatDateDisplay(dateKey: string): string {
  const date = new Date(dateKey);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// =============================================================================
// Icons
// =============================================================================

function MessageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ThreadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export default ChannelMessageList;
