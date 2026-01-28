/**
 * MessageList Component - Mission Control Theme
 *
 * Displays a list of messages with threading support,
 * provider-colored icons, and From → To format.
 */

import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { ACTIVITY_FEED_ID } from './App';
import type { Message, Agent, Attachment } from '../types';
import type { UserPresence } from './hooks/usePresence';
import { MessageStatusIndicator } from './MessageStatusIndicator';
import { ThinkingIndicator } from './ThinkingIndicator';
import { deduplicateBroadcasts } from './hooks/useBroadcastDedup';
import { MessageSenderName } from './MessageSenderName';
import { formatMessageBody } from './utils/messageFormatting';

// Provider icons and colors matching landing page
const PROVIDER_CONFIG: Record<string, { icon: string; color: string }> = {
  claude: { icon: '◈', color: '#00d9ff' },
  codex: { icon: '⬡', color: '#ff6b35' },
  gemini: { icon: '◇', color: '#a855f7' },
  openai: { icon: '◆', color: '#10a37f' },
  default: { icon: '●', color: '#00d9ff' },
};

// Get provider config from agent name (heuristic-based)
function getProviderConfig(agentName: string): { icon: string; color: string } {
  const nameLower = agentName.toLowerCase();
  if (nameLower.includes('claude') || nameLower.includes('anthropic')) {
    return PROVIDER_CONFIG.claude;
  }
  if (nameLower.includes('codex') || nameLower.includes('openai') || nameLower.includes('gpt')) {
    return PROVIDER_CONFIG.codex;
  }
  if (nameLower.includes('gemini') || nameLower.includes('google') || nameLower.includes('bard')) {
    return PROVIDER_CONFIG.gemini;
  }
  // Default: cycle through colors based on name hash
  const hash = agentName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const providers = Object.keys(PROVIDER_CONFIG).filter((k) => k !== 'default');
  const provider = providers[hash % providers.length];
  return PROVIDER_CONFIG[provider];
}

/** Current user info for displaying avatar/username */
export interface CurrentUser {
  displayName: string;
  avatarUrl?: string;
}

export interface MessageListProps {
  messages: Message[];
  currentChannel: string;
  onThreadClick?: (messageId: string) => void;
  highlightedMessageId?: string;
  /** Currently selected thread ID - when set, shows thread-related messages */
  currentThread?: string | null;
  /** Agents list for checking processing state */
  agents?: Agent[];
  /** Current user info (for cloud mode - shows avatar/username instead of "Dashboard") */
  currentUser?: CurrentUser;
  /** Skip channel filtering - messages are already filtered (for DM views) */
  skipChannelFilter?: boolean;
  /** Default auto-scroll preference */
  autoScrollDefault?: boolean;
  /** Show timestamps in message header */
  showTimestamps?: boolean;
  /** Compact spacing for dense layouts */
  compactMode?: boolean;
  /** Callback when an agent name is clicked to open profile */
  onAgentClick?: (agent: Agent) => void;
  /** Callback when a human user name is clicked to open profile */
  onUserClick?: (user: UserPresence) => void;
  /** Online users list for profile lookup */
  onlineUsers?: UserPresence[];
}

export function MessageList({
  messages,
  currentChannel,
  onThreadClick,
  highlightedMessageId,
  currentThread,
  agents = [],
  currentUser,
  skipChannelFilter = false,
  autoScrollDefault = true,
  showTimestamps = true,
  compactMode = false,
  onAgentClick,
  onUserClick,
  onlineUsers = [],
}: MessageListProps) {
  // Build a map of agent name -> processing state for quick lookup
  const processingAgents = new Map<string, { isProcessing: boolean; processingStartedAt?: number }>();
  for (const agent of agents) {
    if (agent.isProcessing) {
      processingAgents.set(agent.name, {
        isProcessing: true,
        processingStartedAt: agent.processingStartedAt,
      });
    }
  }

  // Build a map of recipient -> latest message ID from current user
  // This is used to only show the thinking indicator on the most recent message
  const latestMessageToAgent = new Map<string, string>();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(autoScrollDefault);
  const prevFilteredLengthRef = useRef<number>(0);
  const prevChannelRef = useRef<string>(currentChannel);
  // Track if we should scroll on next render (set before DOM updates)
  const shouldScrollRef = useRef(false);
  // Track if a scroll is in progress to prevent race conditions
  const isScrollingRef = useRef(false);

  useEffect(() => {
    setAutoScroll(autoScrollDefault);
  }, [autoScrollDefault]);

  // Filter messages for current channel or current thread
  const channelFilteredMessages = messages.filter((msg) => {
    // When a thread is selected, show messages related to that thread
    if (currentThread) {
      // Show the original message (id matches thread) or replies (thread field matches)
      return msg.id === currentThread || msg.thread === currentThread;
    }

    // Skip channel filtering if messages are already filtered (e.g., DM views)
    if (skipChannelFilter) {
      return true;
    }

    // Activity feed shows broadcasts
    if (currentChannel === ACTIVITY_FEED_ID) {
      return msg.to === '*' || msg.isBroadcast;
    }
    // #general channel shows only actual channel messages (not broadcasts)
    if (currentChannel === 'general' || currentChannel === '#general') {
      return msg.channel === 'general' || msg.channel === '#general' ||
             msg.to === '#general' || msg.to === 'general';
    }
    return msg.from === currentChannel || msg.to === currentChannel;
  });

  // Deduplicate broadcast messages in Activity feed
  // When a broadcast is sent to '*', the backend delivers it to each recipient separately,
  // causing the same message to appear multiple times. Deduplication removes duplicates
  // by grouping broadcasts with the same sender, content, and timestamp.
  const filteredMessages = currentChannel === ACTIVITY_FEED_ID
    ? deduplicateBroadcasts(channelFilteredMessages)
    : channelFilteredMessages;

  // Populate latestMessageToAgent with the latest message from current user to each agent
  // Iterate in order (oldest to newest) so the last one wins
  for (const msg of filteredMessages) {
    const isFromCurrentUser = msg.from === 'Dashboard' ||
      (currentUser && msg.from === currentUser.displayName);
    if (isFromCurrentUser && msg.to !== '*') {
      latestMessageToAgent.set(msg.to, msg.id);
    }
  }

  const autoScrollAllowed = autoScrollDefault;

  // Check if we need to scroll BEFORE the DOM updates
  // This runs during render, before useLayoutEffect
  const currentLength = filteredMessages.length;
  if (currentLength > prevFilteredLengthRef.current) {
    // Check if the latest message is from the current user
    // This includes both "Dashboard" (local mode) and GitHub username (cloud mode)
    // Scroll for user's own messages only when auto-scroll is enabled
    const latestMessage = filteredMessages[filteredMessages.length - 1];
    const latestIsFromUser = latestMessage?.from === 'Dashboard' ||
      (currentUser && latestMessage?.from === currentUser.displayName);

    if (autoScrollAllowed && (latestIsFromUser || autoScroll)) {
      shouldScrollRef.current = true;
      // Re-enable auto-scroll if we're scrolling for user's message
      // This ensures continued auto-scroll after user sends a message
      if (latestIsFromUser && !autoScroll) {
        setAutoScroll(true);
      }
    }
  }
  prevFilteredLengthRef.current = currentLength;

  // Handle scroll to detect manual scroll (disable/enable auto-scroll)
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    // Skip scroll events that happen during programmatic scrolling
    if (isScrollingRef.current) return;
    if (!autoScrollDefault) return;

    const container = scrollContainerRef.current;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isAtBottom = distanceFromBottom < 50;

    // Re-enable auto-scroll when user scrolls to bottom
    if (isAtBottom && !autoScroll) {
      setAutoScroll(true);
    }
    // Disable auto-scroll when user scrolls significantly away from bottom
    // Use a larger threshold to avoid false disables from small layout shifts
    else if (distanceFromBottom > 150 && autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll]);

  // Auto-scroll to bottom when new messages arrive - use useLayoutEffect for immediate execution
  useLayoutEffect(() => {
    if (shouldScrollRef.current && scrollContainerRef.current) {
      shouldScrollRef.current = false;
      isScrollingRef.current = true;

      const container = scrollContainerRef.current;
      container.scrollTop = container.scrollHeight;

      // Clear the scrolling flag after the scroll event has been processed
      requestAnimationFrame(() => {
        setTimeout(() => {
          isScrollingRef.current = false;
        }, 50);
      });
    }
  }, [filteredMessages.length]);

  // Reset scroll position and auto-scroll when channel changes
  useLayoutEffect(() => {
    if (currentChannel !== prevChannelRef.current) {
      prevChannelRef.current = currentChannel;
      prevFilteredLengthRef.current = filteredMessages.length;
      setAutoScroll(true);

      // Scroll to bottom on channel change
      if (scrollContainerRef.current) {
        isScrollingRef.current = true;
        const container = scrollContainerRef.current;
        container.scrollTop = container.scrollHeight;

        // Clear the scrolling flag after the scroll event has been processed
        requestAnimationFrame(() => {
          setTimeout(() => {
            isScrollingRef.current = false;
          }, 50);
        });
      }
    }
  }, [currentChannel, filteredMessages.length]);

  if (filteredMessages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted text-center">
        <EmptyIcon />
        <h3 className="m-0 mb-2 text-base font-display text-text-secondary">No messages yet</h3>
        <p className="m-0 text-sm">
          {currentChannel === 'general'
            ? 'Broadcast messages will appear here'
            : `Messages with ${currentChannel} will appear here`}
        </p>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col bg-bg-secondary h-full overflow-y-auto ${
        compactMode ? 'gap-0.5 p-1.5 sm:p-2' : 'gap-1 p-2 sm:p-4'
      }`}
      ref={scrollContainerRef}
      onScroll={handleScroll}
    >
      {filteredMessages.map((message) => {
        // Check if message is from current user (Dashboard or GitHub username)
        const isFromCurrentUser = message.from === 'Dashboard' ||
          (currentUser && message.from === currentUser.displayName);

        // Check if this is the latest message from current user to this recipient
        // Only the latest message should show the thinking indicator
        const isLatestToRecipient = isFromCurrentUser && message.to !== '*' &&
          latestMessageToAgent.get(message.to) === message.id;

        // Check if the recipient is currently processing
        // Only show thinking indicator for the LATEST message from current user to an agent
        const recipientProcessing = isLatestToRecipient
          ? processingAgents.get(message.to)
          : undefined;

        return (
          <MessageItem
            key={message.id}
            message={message}
            isHighlighted={message.id === highlightedMessageId}
            onThreadClick={onThreadClick}
            recipientProcessing={recipientProcessing}
            currentUser={currentUser}
            showTimestamps={showTimestamps}
            compactMode={compactMode}
            agents={agents}
            onlineUsers={onlineUsers}
            onAgentClick={onAgentClick}
            onUserClick={onUserClick}
          />
        );
      })}
    </div>
  );
}

interface MessageItemProps {
  message: Message;
  isHighlighted?: boolean;
  onThreadClick?: (messageId: string) => void;
  /** Processing state of the recipient agent (for showing thinking indicator) */
  recipientProcessing?: { isProcessing: boolean; processingStartedAt?: number };
  /** Current user info for displaying avatar/username */
  currentUser?: CurrentUser;
  showTimestamps?: boolean;
  compactMode?: boolean;
  /** All agents for name lookup */
  agents?: Agent[];
  /** Online users for profile lookup */
  onlineUsers?: UserPresence[];
  /** Callback when an agent name is clicked */
  onAgentClick?: (agent: Agent) => void;
  /** Callback when a user name is clicked */
  onUserClick?: (user: UserPresence) => void;
}

function MessageItem({
  message,
  isHighlighted,
  onThreadClick,
  recipientProcessing,
  currentUser,
  showTimestamps = true,
  compactMode = false,
  agents = [],
  onlineUsers = [],
  onAgentClick,
  onUserClick,
}: MessageItemProps) {
  const timestamp = formatTimestamp(message.timestamp);

  // Check if this message is from the current user (Dashboard or their GitHub username)
  const isFromCurrentUser = message.from === 'Dashboard' ||
    (currentUser && message.from === currentUser.displayName);

  // Get provider config for agent messages, or use user styling for current user
  const provider = isFromCurrentUser && currentUser
    ? { icon: '', color: '#a855f7' } // Purple for user messages
    : getProviderConfig(message.from);

  // Display name: use GitHub username if available, otherwise message.from
  const displayName = isFromCurrentUser && currentUser
    ? currentUser.displayName
    : message.from;
  const replyCount = message.threadSummary?.replyCount ?? message.replyCount ?? 0;
  const hasReplies = replyCount > 0;

  // Look up agent or user for sender (for clickable profile)
  const senderAgent = agents.find(a => a.name.toLowerCase() === message.from.toLowerCase() && !a.isHuman);
  const senderUser = onlineUsers.find(u => u.username.toLowerCase() === message.from.toLowerCase());

  // Look up agent or user for recipient (for clickable profile)
  const recipientAgent = message.to !== '*' ? agents.find(a => a.name.toLowerCase() === message.to.toLowerCase() && !a.isHuman) : undefined;
  const recipientUser = message.to !== '*' ? onlineUsers.find(u => u.username.toLowerCase() === message.to.toLowerCase()) : undefined;
  const recipientProviderConfig = recipientAgent ? getProviderConfig(message.to) : undefined;

  // Show thinking indicator when:
  // 1. Message is from Dashboard or current user (user sent it)
  // 2. Message has been delivered (acked)
  // 3. Recipient is currently processing
  const showThinking = isFromCurrentUser &&
    (message.status === 'acked' || message.status === 'read') &&
    recipientProcessing?.isProcessing;

  return (
    <div
      className={`
        group flex rounded-xl transition-all duration-150
        ${compactMode ? 'gap-2 py-1.5 px-2' : 'gap-2 sm:gap-3 py-2 sm:py-3 px-2 sm:px-4'}
        hover:bg-bg-card/50
        ${isHighlighted ? 'bg-warning-light/20 border-l-2 border-l-warning pl-2 sm:pl-3' : ''}
      `}
    >
      {/* Avatar/Icon */}
      {isFromCurrentUser && currentUser?.avatarUrl ? (
        <img
          src={currentUser.avatarUrl}
          alt={displayName}
          className={`shrink-0 rounded-lg sm:rounded-xl border-2 object-cover ${
            compactMode ? 'w-7 h-7 sm:w-8 sm:h-8' : 'w-8 h-8 sm:w-10 sm:h-10'
          }`}
          style={{
            borderColor: provider.color,
            boxShadow: `0 0 16px ${provider.color}30`,
          }}
        />
      ) : senderUser?.avatarUrl ? (
        <img
          src={senderUser.avatarUrl}
          alt={displayName}
          className={`shrink-0 rounded-lg sm:rounded-xl border-2 object-cover ${
            compactMode ? 'w-7 h-7 sm:w-8 sm:h-8' : 'w-8 h-8 sm:w-10 sm:h-10'
          }`}
          style={{
            borderColor: provider.color,
            boxShadow: `0 0 16px ${provider.color}30`,
          }}
        />
      ) : (
        <div
          className={`shrink-0 rounded-lg sm:rounded-xl flex items-center justify-center font-medium border-2 ${
            compactMode ? 'w-7 h-7 sm:w-8 sm:h-8 text-sm sm:text-base' : 'w-8 h-8 sm:w-10 sm:h-10 text-base sm:text-lg'
          }`}
          style={{
            backgroundColor: `${provider.color}15`,
            borderColor: provider.color,
            color: provider.color,
            boxShadow: `0 0 16px ${provider.color}30`,
          }}
        >
          {provider.icon}
        </div>
      )}

      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Message Header */}
        <div className={`flex items-center gap-2 flex-wrap ${compactMode ? 'mb-1' : 'mb-1.5'}`}>
          <MessageSenderName
            displayName={displayName}
            color={provider.color}
            isCurrentUser={isFromCurrentUser}
            agent={senderAgent}
            userPresence={senderUser}
            onAgentClick={onAgentClick}
            onUserClick={onUserClick}
          />

          {message.to !== '*' && (
            <>
              <span className="text-text-dim text-xs">→</span>
              <MessageSenderName
                displayName={message.to}
                color={recipientProviderConfig?.color || '#00d9ff'}
                agent={recipientAgent}
                userPresence={recipientUser}
                onAgentClick={onAgentClick}
                onUserClick={onUserClick}
              />
            </>
          )}

          {message.thread && (
            <span className="text-xs py-0.5 px-2 rounded-full font-mono font-medium bg-accent-purple/20 text-accent-purple">
              {message.thread}
            </span>
          )}

          {message.to === '*' && (
            <span className="text-xs py-0.5 px-2 rounded-full uppercase font-medium bg-warning/20 text-warning">
              broadcast
            </span>
          )}

          {showTimestamps && (
            <span className="text-text-dim text-xs ml-auto font-mono">{timestamp}</span>
          )}

          {/* Message status indicator - show for messages sent by current user */}
          {isFromCurrentUser && (
            <MessageStatusIndicator status={message.status} size="small" />
          )}

          {/* Thinking indicator - show when recipient is processing */}
          {showThinking && (
            <ThinkingIndicator
              isProcessing={true}
              processingStartedAt={recipientProcessing?.processingStartedAt}
              size="small"
              showLabel={true}
            />
          )}

          {/* Thread/Reply button */}
          <button
            className={`
              inline-flex items-center gap-1.5 p-1.5 rounded-lg transition-all duration-150 cursor-pointer border-none
              ${hasReplies || message.thread
                ? 'text-accent-cyan bg-accent-cyan/10 hover:bg-accent-cyan/20'
                : 'text-text-muted bg-transparent opacity-0 group-hover:opacity-100 hover:text-accent-cyan hover:bg-accent-cyan/10'}
            `}
            onClick={() => onThreadClick?.(message.thread || message.id)}
            title={message.thread ? `View thread: ${message.thread}` : (hasReplies ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread')}
          >
            <ThreadIcon />
            {hasReplies && (
              <span className="text-xs font-medium">{replyCount}</span>
            )}
          </button>
        </div>

        {/* Message Content */}
        <div className="text-sm leading-relaxed text-text-primary whitespace-pre-wrap break-words">
          {formatMessageBody(message.content)}
        </div>

        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <MessageAttachments attachments={message.attachments} />
        )}
      </div>
    </div>
  );
}

/**
 * Message Attachments Component
 * Displays image attachments with lightbox functionality
 */
interface MessageAttachmentsProps {
  attachments: Attachment[];
}

function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  const [lightboxImage, setLightboxImage] = useState<Attachment | null>(null);

  const imageAttachments = attachments.filter(a =>
    a.mimeType.startsWith('image/')
  );

  if (imageAttachments.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-2">
        {imageAttachments.map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            onClick={() => setLightboxImage(attachment)}
            className="relative group cursor-pointer bg-transparent border-0 p-0"
            title={`View ${attachment.filename}`}
          >
            <img
              src={attachment.data || attachment.url}
              alt={attachment.filename}
              className="max-h-48 max-w-xs rounded-lg border border-border-subtle object-cover transition-all duration-150 group-hover:border-accent-cyan/50 group-hover:shadow-[0_0_8px_rgba(0,217,255,0.2)]"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 rounded-lg transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                className="drop-shadow-lg"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </div>
          </button>
        ))}
      </div>

      {/* Lightbox Modal */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightboxImage(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <img
              src={lightboxImage.data || lightboxImage.url}
              alt={lightboxImage.filename}
              className="max-w-full max-h-[90vh] rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              className="absolute -top-3 -right-3 w-8 h-8 bg-bg-tertiary border border-border-subtle rounded-full flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-bg-card transition-colors shadow-lg"
              title="Close"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/60 to-transparent rounded-b-lg">
              <p className="text-white text-sm truncate">{lightboxImage.filename}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: string | number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  if (isYesterday) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function EmptyIcon() {
  return (
    <svg className="mb-4 opacity-50 text-text-muted" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ThreadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
