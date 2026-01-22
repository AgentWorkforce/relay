/**
 * ChannelChat Component
 *
 * Chat view for a channel or DM conversation.
 * Displays messages and provides input for sending new messages.
 * Uses shared MessageComposer for consistent attachment/paste support.
 */

import React, { useCallback, useRef, useEffect } from 'react';
import type { ChannelMessage } from './hooks/useChannels';
import type { Agent } from '../types';
import type { UserPresence } from './hooks/usePresence';
import { MessageSenderName } from './MessageSenderName';
import { MessageComposer } from './MessageComposer';
import type { HumanUser } from './MentionAutocomplete';

export interface ChannelChatProps {
  /** Current channel name */
  channel: string;
  /** Messages in this channel */
  messages: ChannelMessage[];
  /** Current user's username */
  currentUser: string;
  /** Send a message (now supports attachments) */
  onSendMessage: (body: string, thread?: string, attachmentIds?: string[]) => void;
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
  /** Whether message sending is in progress */
  isSending?: boolean;
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
  isSending = false,
}: ChannelChatProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  // Handle message send with attachments
  const handleSend = useCallback(async (content: string, attachmentIds?: string[]): Promise<boolean> => {
    if (!content.trim() && (!attachmentIds || attachmentIds.length === 0)) return false;
    onSendMessage(content, undefined, attachmentIds);
    return true;
  }, [onSendMessage]);

  const isDm = channel.startsWith('dm:');
  const channelDisplay = isDm
    ? channel.split(':').slice(1).filter(u => u !== currentUser).join(', ')
    : channel;

  // Convert online user presence to HumanUser format for mentions
  const humanUsers: HumanUser[] = onlineUserPresence.map(u => ({
    username: u.username,
    avatarUrl: u.avatarUrl,
  }));

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

      {/* Input - Using shared MessageComposer for attachment support */}
      <div style={{
        padding: '16px 20px',
        borderTop: '1px solid var(--border-color, #313244)',
      }}>
        <MessageComposer
          onSend={handleSend}
          isSending={isSending}
          placeholder={`Message ${channelDisplay}...`}
          agents={agents}
          humanUsers={humanUsers}
        />
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
