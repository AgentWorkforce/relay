/**
 * MessageList Component - Mission Control Theme
 *
 * Displays a list of messages with threading support,
 * provider-colored icons, and From → To format.
 */

import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
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
  /** Agents list for checking processing state */
  agents?: Agent[];
  /** Current user info (for cloud mode - shows avatar/username instead of "Dashboard") */
  currentUser?: CurrentUser;
}

export function MessageList({
  messages,
  currentChannel,
  onThreadClick,
  highlightedMessageId,
  agents = [],
  currentUser,
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
  // Track if we should scroll on next render (set before DOM updates)
  const shouldScrollRef = useRef(false);
  // Track if a scroll is in progress to prevent race conditions
  const isScrollingRef = useRef(false);

  // Filter messages for current channel
  const filteredMessages = messages.filter((msg) => {
    if (currentChannel === 'general') {
      // Show messages that are broadcasts (to='*' or isBroadcast flag)
      // Also show messages that have channel='general' in their metadata
      // This includes agent replies to broadcasts that preserve the channel context
      return msg.to === '*' || msg.isBroadcast || msg.channel === 'general';
    }
    return msg.from === currentChannel || msg.to === currentChannel;
  });

  // Check if we need to scroll BEFORE the DOM updates
  // This runs during render, before useLayoutEffect
  const currentLength = filteredMessages.length;
  if (currentLength > prevFilteredLengthRef.current) {
    // Check if the latest message is from the current user
    // This includes both "Dashboard" (local mode) and GitHub username (cloud mode)
    // Always scroll for user's own messages, regardless of autoScroll state
    const latestMessage = filteredMessages[filteredMessages.length - 1];
    const latestIsFromUser = latestMessage?.from === 'Dashboard' ||
      (currentUser && latestMessage?.from === currentUser.displayName);

    if (latestIsFromUser || autoScroll) {
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
      className="flex flex-col gap-1 p-4 bg-bg-secondary h-full overflow-y-auto"
      ref={scrollContainerRef}
      onScroll={handleScroll}
    >
      {filteredMessages.map((message) => {
        // Check if message is from current user (Dashboard or GitHub username)
        const isFromCurrentUser = message.from === 'Dashboard' ||
          (currentUser && message.from === currentUser.displayName);

        // Check if the recipient is currently processing
        // Only show thinking indicator for messages from current user to a specific agent
        const recipientProcessing = isFromCurrentUser && message.to !== '*'
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
}

function MessageItem({ message, isHighlighted, onThreadClick, recipientProcessing, currentUser }: MessageItemProps) {
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
  const hasReplies = message.replyCount && message.replyCount > 0;

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
        group flex gap-3 py-3 px-4 rounded-xl transition-all duration-150
        hover:bg-bg-card/50
        ${isHighlighted ? 'bg-warning-light/20 border-l-2 border-l-warning pl-3' : ''}
      `}
    >
      {/* Avatar/Icon */}
      {isFromCurrentUser && currentUser?.avatarUrl ? (
        <img
          src={currentUser.avatarUrl}
          alt={displayName}
          className="shrink-0 w-10 h-10 rounded-xl border-2 object-cover"
          style={{
            borderColor: provider.color,
            boxShadow: `0 0 16px ${provider.color}30`,
          }}
        />
      ) : (
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
      )}

      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Message Header */}
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <span
            className="font-display font-semibold text-sm"
            style={{ color: provider.color }}
          >
            {displayName}
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
 * Custom theme extending oneDark to match dashboard styling
 */
const customCodeTheme = {
  ...oneDark,
  'pre[class*="language-"]': {
    ...oneDark['pre[class*="language-"]'],
    background: 'rgba(15, 23, 42, 0.8)',
    margin: '0.5rem 0',
    padding: '1rem',
    borderRadius: '0.5rem',
    border: '1px solid rgba(148, 163, 184, 0.1)',
    fontSize: '0.75rem',
    lineHeight: '1.5',
  },
  'code[class*="language-"]': {
    ...oneDark['code[class*="language-"]'],
    background: 'transparent',
    fontSize: '0.75rem',
  },
};

/**
 * CodeBlock Component - Renders syntax highlighted code
 */
interface CodeBlockProps {
  code: string;
  language: string;
}

function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [code]);

  // Normalize language names for syntax highlighter
  const normalizedLanguage = language.toLowerCase().replace(/^(js|jsx)$/, 'javascript')
    .replace(/^(ts|tsx)$/, 'typescript')
    .replace(/^(py)$/, 'python')
    .replace(/^(rb)$/, 'ruby')
    .replace(/^(sh|shell|zsh)$/, 'bash');

  return (
    <div className="relative group my-2">
      {/* Language badge and copy button */}
      <div className="absolute top-2 right-2 flex items-center gap-2 z-10">
        {language && language !== 'text' && (
          <span className="text-xs px-2 py-0.5 rounded bg-accent-cyan/20 text-accent-cyan font-mono">
            {language}
          </span>
        )}
        <button
          onClick={handleCopy}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-xs px-2 py-1 rounded bg-bg-tertiary hover:bg-bg-card text-text-muted hover:text-text-primary border border-border-subtle"
          title="Copy code"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={normalizedLanguage}
        style={customCodeTheme}
        customStyle={{
          margin: 0,
          background: 'rgba(15, 23, 42, 0.8)',
        }}
        showLineNumbers={code.split('\n').length > 3}
        lineNumberStyle={{
          minWidth: '2.5em',
          paddingRight: '1em',
          color: 'rgba(148, 163, 184, 0.4)',
          userSelect: 'none',
        }}
      >
        {code.trim()}
      </SyntaxHighlighter>
    </div>
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
  type: 'text' | 'table' | 'code';
  content: string;
  language?: string;
}

/**
 * Split content into text, table, and code sections
 * Code blocks are detected by fenced code block syntax (```language ... ```)
 */
function splitContentSections(content: string): ContentSection[] {
  const sections: ContentSection[] = [];

  // First, extract code blocks using regex
  // Matches ```language\ncode\n``` or ```\ncode\n```
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add any content before this code block
    if (match.index > lastIndex) {
      const beforeContent = content.slice(lastIndex, match.index);
      const beforeSections = splitTextAndTableSections(beforeContent);
      sections.push(...beforeSections);
    }

    // Add the code block
    sections.push({
      type: 'code',
      language: match[1] || 'text',
      content: match[2],
    });

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining content after the last code block
  if (lastIndex < content.length) {
    const afterContent = content.slice(lastIndex);
    const afterSections = splitTextAndTableSections(afterContent);
    sections.push(...afterSections);
  }

  // If no code blocks were found, just split text/tables
  if (sections.length === 0) {
    return splitTextAndTableSections(content);
  }

  return sections;
}

/**
 * Split content into text and table sections (helper for non-code content)
 */
function splitTextAndTableSections(content: string): ContentSection[] {
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

  // Render mixed content with tables and code blocks
  return sections.map((section, sectionIndex) => {
    if (section.type === 'code') {
      return (
        <CodeBlock
          key={sectionIndex}
          code={section.content}
          language={section.language || 'text'}
        />
      );
    }

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
