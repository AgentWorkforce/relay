/**
 * ChannelChat Component
 *
 * Chat view for a channel or DM conversation.
 * Displays messages and provides input for sending new messages.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { ChannelMessage } from './hooks/useChannels';
import type { Agent } from '../types';
import type { UserPresence } from './hooks/usePresence';
import { MessageSenderName } from './MessageSenderName';

export interface ChannelChatProps {
  /** Current channel name */
  channel: string;
  /** Messages in this channel */
  messages: ChannelMessage[];
  /** Current user's username */
  currentUser: string;
  /** Send a message */
  onSendMessage: (body: string, thread?: string) => void;
  /** Online users for mentions */
  onlineUsers?: string[];
  /** Agents list for profile lookup */
  agents?: Agent[];
  /** Online user presence list for profile lookup */
  onlineUserPresence?: UserPresence[];
  /** Callback when agent name is clicked */
  onAgentClick?: (agent: Agent) => void;
  /** Callback when user name is clicked */
  onUserClick?: (user: UserPresence) => void;
}

export function ChannelChat({
  channel,
  messages,
  currentUser,
  onSendMessage,
  onlineUsers = [],
  agents = [],
  onlineUserPresence = [],
  onAgentClick,
  onUserClick,
}: ChannelChatProps) {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Filter messages for this channel
  const channelMessages = messages.filter(m => {
    if (m.type === 'channel_message') {
      return m.channel === channel;
    }
    // For DMs, check if this is the right conversation
    if (m.type === 'direct_message' && channel.startsWith('dm:')) {
      const participants = channel.split(':').slice(1);
      return participants.includes(m.from) || participants.includes(m.to || '');
    }
    return false;
  });

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [channelMessages.length]);

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    onSendMessage(trimmed);
    setInputValue('');
    inputRef.current?.focus();
  }, [inputValue, onSendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const isDm = channel.startsWith('dm:');
  const channelDisplay = isDm
    ? channel.split(':').slice(1).filter(u => u !== currentUser).join(', ')
    : channel;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      backgroundColor: 'var(--bg-primary, #11111b)',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--border-color, #313244)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <span style={{
          fontSize: '16px',
          fontWeight: 600,
          color: 'var(--text-primary, #cdd6f4)',
        }}>
          {isDm ? '@' : ''}{channelDisplay}
        </span>
        {!isDm && (
          <span style={{
            fontSize: '13px',
            color: 'var(--text-muted, #6c7086)',
          }}>
            Channel
          </span>
        )}
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflow: 'auto',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}>
        {channelMessages.length === 0 ? (
          <div style={{
            textAlign: 'center',
            color: 'var(--text-muted, #6c7086)',
            padding: '40px 20px',
          }}>
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>
              {isDm ? '👋' : '💬'}
            </div>
            <div style={{ fontSize: '16px', fontWeight: 500, marginBottom: '4px' }}>
              {isDm
                ? `Start a conversation with ${channelDisplay}`
                : `Welcome to ${channel}`}
            </div>
            <div style={{ fontSize: '13px' }}>
              {isDm
                ? 'Send a message to get started'
                : 'This is the beginning of the channel'}
            </div>
          </div>
        ) : (
          channelMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isOwn={msg.from === currentUser}
              agents={agents}
              onlineUserPresence={onlineUserPresence}
              onAgentClick={onAgentClick}
              onUserClick={onUserClick}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '16px 20px',
        borderTop: '1px solid var(--border-color, #313244)',
      }}>
        <div style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-end',
        }}>
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${channelDisplay}...`}
            style={{
              flex: 1,
              padding: '12px 16px',
              backgroundColor: 'var(--bg-secondary, #1e1e2e)',
              border: '1px solid var(--border-color, #313244)',
              borderRadius: '8px',
              color: 'var(--text-primary, #cdd6f4)',
              fontSize: '14px',
              resize: 'none',
              minHeight: '44px',
              maxHeight: '120px',
              outline: 'none',
              fontFamily: 'inherit',
            }}
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!inputValue.trim()}
            style={{
              padding: '12px 20px',
              backgroundColor: inputValue.trim()
                ? 'var(--accent-color, #89b4fa)'
                : 'var(--bg-tertiary, #313244)',
              border: 'none',
              borderRadius: '8px',
              color: inputValue.trim() ? '#11111b' : 'var(--text-muted, #6c7086)',
              fontSize: '14px',
              fontWeight: 500,
              cursor: inputValue.trim() ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
            }}
          >
            Send
          </button>
        </div>
        <div style={{
          fontSize: '12px',
          color: 'var(--text-muted, #6c7086)',
          marginTop: '8px',
        }}>
          Press Enter to send, Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: ChannelMessage;
  isOwn: boolean;
  agents?: Agent[];
  onlineUserPresence?: UserPresence[];
  onAgentClick?: (agent: Agent) => void;
  onUserClick?: (user: UserPresence) => void;
}

function MessageBubble({
  message,
  isOwn,
  agents = [],
  onlineUserPresence = [],
  onAgentClick,
  onUserClick,
}: MessageBubbleProps) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  // Look up agent or user for the sender
  const senderAgent = agents.find(a => a.name.toLowerCase() === message.from.toLowerCase() && !a.isHuman);
  const senderUser = onlineUserPresence.find(u => u.username.toLowerCase() === message.from.toLowerCase());

  const nameColor = isOwn
    ? 'var(--accent-color, #89b4fa)'
    : 'var(--text-primary, #cdd6f4)';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isOwn ? 'flex-end' : 'flex-start',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        marginBottom: '4px',
      }}>
        <MessageSenderName
          displayName={message.from}
          color={nameColor}
          isCurrentUser={isOwn}
          agent={senderAgent}
          userPresence={senderUser}
          onAgentClick={onAgentClick}
          onUserClick={onUserClick}
        />
        <span style={{
          fontSize: '11px',
          color: 'var(--text-muted, #6c7086)',
        }}>
          {time}
        </span>
      </div>
      <div style={{
        maxWidth: '70%',
        padding: '10px 14px',
        backgroundColor: isOwn
          ? 'var(--accent-color, #89b4fa)'
          : 'var(--bg-secondary, #1e1e2e)',
        color: isOwn ? '#11111b' : 'var(--text-primary, #cdd6f4)',
        borderRadius: isOwn ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        fontSize: '14px',
        lineHeight: '1.4',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
      }}>
        {message.body}
      </div>
    </div>
  );
}

export default ChannelChat;
