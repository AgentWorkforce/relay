/**
 * MessageList Component - Mission Control Theme
 *
 * Displays a list of messages with threading support,
 * provider-colored icons, and From → To format.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { Message, Agent, Attachment } from '../types';
import { MessageStatusIndicator } from './MessageStatusIndicator';
import { ThinkingIndicator } from './ThinkingIndicator';

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

export interface MessageListProps {
  messages: Message[];
  currentChannel: string;
  onThreadClick?: (messageId: string) => void;
  highlightedMessageId?: string;
  /** Agents list for checking processing state */
  agents?: Agent[];
}

export function MessageList({
  messages,
  currentChannel,
  onThreadClick,
  highlightedMessageId,
  agents = [],
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const prevFilteredLengthRef = useRef<number>(0);
  const prevChannelRef = useRef<string>(currentChannel);

  // Filter messages for current channel
  const filteredMessages = messages.filter((msg) => {
    if (currentChannel === 'general') {
      return msg.to === '*' || msg.isBroadcast;
    }
    return msg.from === currentChannel || msg.to === currentChannel;
  });

  // Handle scroll to detect manual scroll (disable/enable auto-scroll)
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    const isAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 50;

    // Re-enable auto-scroll when user scrolls to bottom
    if (isAtBottom && !autoScroll) {
      setAutoScroll(true);
    }
    // Disable auto-scroll when user scrolls away from bottom
    else if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      container.scrollTop = container.scrollHeight;
    }
  }, [filteredMessages.length, autoScroll]);

  // Reset scroll position and auto-scroll when channel changes
  useEffect(() => {
    if (currentChannel !== prevChannelRef.current) {
      prevChannelRef.current = currentChannel;
      prevFilteredLengthRef.current = 0;
      setAutoScroll(true);
      // Scroll to bottom on channel change
      if (scrollContainerRef.current) {
        const container = scrollContainerRef.current;
        // Use setTimeout to ensure DOM has updated
        setTimeout(() => {
          container.scrollTop = container.scrollHeight;
        }, 0);
      }
    }
  }, [currentChannel]);

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
      className="flex flex-col gap-1 p-4 bg-bg-secondary h-full overflow-y-auto"
      ref={scrollContainerRef}
      onScroll={handleScroll}
    >
      {filteredMessages.map((message) => {
        // Check if the recipient is currently processing
        // Only show thinking indicator for messages from Dashboard to a specific agent
        const recipientProcessing = message.from === 'Dashboard' && message.to !== '*'
          ? processingAgents.get(message.to)
          : undefined;

        return (
          <MessageItem
            key={message.id}
            message={message}
            isHighlighted={message.id === highlightedMessageId}
            onThreadClick={onThreadClick}
            recipientProcessing={recipientProcessing}
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
}

function MessageItem({ message, isHighlighted, onThreadClick, recipientProcessing }: MessageItemProps) {
  const provider = getProviderConfig(message.from);
  const timestamp = formatTimestamp(message.timestamp);
  const hasReplies = message.replyCount && message.replyCount > 0;

  // Show thinking indicator when:
  // 1. Message is from Dashboard (user sent it)
  // 2. Message has been delivered (acked)
  // 3. Recipient is currently processing
  const showThinking = message.from === 'Dashboard' &&
    (message.status === 'acked' || message.status === 'read') &&
    recipientProcessing?.isProcessing;

  return (
    <div
      className={`
        group flex gap-3 py-3 px-4 rounded-xl transition-all duration-150
        hover:bg-bg-card/50
        ${isHighlighted ? 'bg-warning-light/20 border-l-2 border-l-warning pl-3' : ''}
      `}
    >
      {/* Provider Icon */}
      <div
        className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-lg font-medium border-2"
        style={{
          backgroundColor: `${provider.color}15`,
          borderColor: provider.color,
          color: provider.color,
          boxShadow: `0 0 16px ${provider.color}30`,
        }}
      >
        {provider.icon}
      </div>

      <div className="flex-1 min-w-0">
        {/* Message Header */}
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <span
            className="font-display font-semibold text-sm"
            style={{ color: provider.color }}
          >
            {message.from}
          </span>

          {message.to !== '*' && (
            <>
              <span className="text-text-dim text-xs">→</span>
              <span className="font-medium text-sm text-accent-cyan">{message.to}</span>
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

          <span className="text-text-dim text-xs ml-auto font-mono">{timestamp}</span>

          {/* Message status indicator - show for messages sent from Dashboard */}
          {message.from === 'Dashboard' && (
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
            title={message.thread ? `View thread: ${message.thread}` : (hasReplies ? `${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread')}
          >
            <ThreadIcon />
            {hasReplies && (
              <span className="text-xs font-medium">{message.replyCount}</span>
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
              src={attachment.url}
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
              src={lightboxImage.url}
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
 * Check if a line looks like part of a table (has pipe characters)
 */
function isTableLine(line: string): boolean {
  const pipeCount = (line.match(/\|/g) || []).length;
  return pipeCount >= 2 || (line.trim().startsWith('|') && line.trim().endsWith('|'));
}

/**
 * Check if a line is a table separator (dashes and pipes)
 */
function isTableSeparator(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|');
}

interface ContentSection {
  type: 'text' | 'table';
  content: string;
}

/**
 * Split content into text and table sections
 */
function splitContentSections(content: string): ContentSection[] {
  const lines = content.split('\n');
  const sections: ContentSection[] = [];
  let currentSection: ContentSection | null = null;

  for (const line of lines) {
    const lineIsTable = isTableLine(line) || isTableSeparator(line);
    const sectionType = lineIsTable ? 'table' : 'text';

    if (!currentSection || currentSection.type !== sectionType) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = { type: sectionType, content: line };
    } else {
      currentSection.content += '\n' + line;
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Format message body with newline preservation, link detection, and table support
 */
function formatMessageBody(content: string): React.ReactNode {
  let normalizedContent = content
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const sections = splitContentSections(normalizedContent);

  // If only one section and not a table, use simple rendering
  if (sections.length === 1 && sections[0].type === 'text') {
    const lines = normalizedContent.split('\n');
    return lines.map((line, i) => (
      <React.Fragment key={i}>
        {i > 0 && <br />}
        {formatLine(line)}
      </React.Fragment>
    ));
  }

  // Render mixed content with tables
  return sections.map((section, sectionIndex) => {
    if (section.type === 'table') {
      return (
        <pre
          key={sectionIndex}
          className="font-mono text-xs leading-relaxed whitespace-pre overflow-x-auto my-2 p-3 bg-bg-tertiary/50 rounded-lg border border-border-subtle"
        >
          {section.content}
        </pre>
      );
    }

    // Regular text section
    const lines = section.content.split('\n');
    return (
      <span key={sectionIndex}>
        {lines.map((line, i) => (
          <React.Fragment key={i}>
            {i > 0 && <br />}
            {formatLine(line)}
          </React.Fragment>
        ))}
      </span>
    );
  });
}

/**
 * Format a single line, detecting URLs
 */
function formatLine(line: string): React.ReactNode {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = line.split(urlRegex);

  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-cyan no-underline hover:underline"
        >
          {part}
        </a>
      );
    }
    return part;
  });
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
