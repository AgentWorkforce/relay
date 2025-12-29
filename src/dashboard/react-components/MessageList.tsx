/**
 * MessageList Component
 *
 * Displays a list of messages with threading support,
 * sender avatars, and timestamp formatting.
 */

import React, { useRef, useEffect } from 'react';
import type { Message } from '../types';
import { getAgentColor, getAgentInitials } from '../lib/colors';

export interface MessageListProps {
  messages: Message[];
  currentChannel: string;
  onThreadClick?: (messageId: string) => void;
  highlightedMessageId?: string;
}

export function MessageList({
  messages,
  currentChannel,
  onThreadClick,
  highlightedMessageId,
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Filter messages for current channel
  const filteredMessages = messages.filter((msg) => {
    if (currentChannel === 'general') {
      return msg.to === '*' || msg.isBroadcast;
    }
    return msg.from === currentChannel || msg.to === currentChannel;
  });

  if (filteredMessages.length === 0) {
    return (
      <div className="message-list-empty">
        <EmptyIcon />
        <h3>No messages yet</h3>
        <p>
          {currentChannel === 'general'
            ? 'Broadcast messages will appear here'
            : `Messages with ${currentChannel} will appear here`}
        </p>
      </div>
    );
  }

  return (
    <div className="message-list" ref={listRef}>
      {filteredMessages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          isHighlighted={message.id === highlightedMessageId}
          onThreadClick={onThreadClick}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

interface MessageItemProps {
  message: Message;
  isHighlighted?: boolean;
  onThreadClick?: (messageId: string) => void;
}

function MessageItem({ message, isHighlighted, onThreadClick }: MessageItemProps) {
  const colors = getAgentColor(message.from);
  const timestamp = formatTimestamp(message.timestamp);

  return (
    <div className={`message-item ${isHighlighted ? 'highlighted' : ''}`}>
      <div
        className="message-avatar"
        style={{ backgroundColor: colors.primary }}
      >
        <span style={{ color: colors.text }}>
          {getAgentInitials(message.from)}
        </span>
      </div>

      <div className="message-content">
        <div className="message-header">
          <span className="message-sender">{message.from}</span>
          {message.to !== '*' && (
            <>
              <span className="message-arrow">→</span>
              <span className="message-recipient">{message.to}</span>
            </>
          )}
          <span className="message-time">{timestamp}</span>
          {message.to === '*' && (
            <span className="message-badge broadcast">broadcast</span>
          )}
        </div>

        <div className="message-body">
          {formatMessageBody(message.content)}
        </div>

        {message.replyCount && message.replyCount > 0 && (
          <button
            className="message-thread-btn"
            onClick={() => onThreadClick?.(message.id)}
          >
            <ThreadIcon />
            <span>{message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Format message body with newline preservation and link detection
 */
function formatMessageBody(content: string): React.ReactNode {
  // Normalize line endings: handle \r\n, literal \\n strings, and \n
  let normalizedContent = content
    .replace(/\\n/g, '\n')  // Convert literal \n strings to actual newlines
    .replace(/\r\n/g, '\n') // Normalize Windows line endings
    .replace(/\r/g, '\n');  // Handle standalone \r

  // Split by newlines and render each line
  const lines = normalizedContent.split('\n');

  return lines.map((line, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {formatLine(line)}
    </React.Fragment>
  ));
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
          className="message-link"
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
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
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

/**
 * CSS styles for the message list - Dark mode styling matching v1 dashboard
 */
export const messageListStyles = `
.message-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  background: #222529;
}

.message-list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #8d8d8e;
  text-align: center;
}

.message-list-empty svg {
  margin-bottom: 16px;
  opacity: 0.5;
  color: #5f6368;
}

.message-list-empty h3 {
  margin: 0 0 8px;
  font-size: 16px;
  color: #ababad;
}

.message-list-empty p {
  margin: 0;
  font-size: 13px;
  color: #8d8d8e;
}

.message-item {
  display: flex;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  transition: background 0.15s;
}

.message-item:hover {
  background: rgba(255, 255, 255, 0.03);
}

.message-item.highlighted {
  background: rgba(232, 164, 39, 0.1);
  border-left: 3px solid #e8a427;
  padding-left: 9px;
}

.message-avatar {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 12px;
  color: white;
}

.message-content {
  flex: 1;
  min-width: 0;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.message-sender {
  font-weight: 600;
  font-size: 14px;
  color: #d1d2d3;
}

.message-arrow {
  color: #8d8d8e;
  font-size: 12px;
}

.message-recipient {
  font-weight: 500;
  font-size: 13px;
  color: #1d9bd1;
}

.message-time {
  color: #8d8d8e;
  font-size: 11px;
  margin-left: auto;
}

.message-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: uppercase;
  font-weight: 500;
}

.message-badge.broadcast {
  background: rgba(232, 164, 39, 0.15);
  color: #e8a427;
}

.message-body {
  font-size: 14px;
  line-height: 1.5;
  color: #d1d2d3;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-body code {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 13px;
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 4px;
  border-radius: 3px;
  color: #00ffc8;
}

.message-body pre {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 13px;
  background: rgba(0, 0, 0, 0.3);
  padding: 12px;
  border-radius: 4px;
  margin: 8px 0;
  overflow-x: auto;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.message-link {
  color: #1d9bd1;
  text-decoration: none;
}

.message-link:hover {
  text-decoration: underline;
  color: #4ab8e8;
}

.message-thread-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  color: #1d9bd1;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.message-thread-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
  color: #4ab8e8;
}

.message-thread-btn svg {
  opacity: 0.7;
}
`;
