/**
 * useMessages Hook
 *
 * React hook for managing message state with filtering,
 * threading, and send functionality.
 */

import { useState, useMemo, useCallback } from 'react';
import type { Message, SendMessageRequest } from '../../types';

export interface UseMessagesOptions {
  messages: Message[];
  currentChannel?: string;
}

export interface UseMessagesReturn {
  // Filtered messages
  messages: Message[];
  threadMessages: (threadId: string) => Message[];

  // Channel/thread state
  currentChannel: string;
  setCurrentChannel: (channel: string) => void;
  currentThread: string | null;
  setCurrentThread: (threadId: string | null) => void;

  // Message actions
  sendMessage: (to: string, content: string, thread?: string) => Promise<boolean>;
  isSending: boolean;
  sendError: string | null;

  // Stats
  totalCount: number;
  unreadCount: number;
}

export function useMessages({
  messages,
  currentChannel: initialChannel = 'general',
}: UseMessagesOptions): UseMessagesReturn {
  const [currentChannel, setCurrentChannel] = useState(initialChannel);
  const [currentThread, setCurrentThread] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Filter messages by current channel
  const filteredMessages = useMemo(() => {
    if (currentChannel === 'general') {
      return messages;
    }
    return messages.filter(
      (m) => m.from === currentChannel || m.to === currentChannel
    );
  }, [messages, currentChannel]);

  // Get messages for a specific thread
  const threadMessages = useCallback(
    (threadId: string) => messages.filter((m) => m.thread === threadId),
    [messages]
  );

  // Calculate stats
  const stats = useMemo(() => {
    const unread = messages.filter((m) => !m.isRead).length;
    return {
      totalCount: messages.length,
      unreadCount: unread,
    };
  }, [messages]);

  // Send message function
  const sendMessage = useCallback(
    async (to: string, content: string, thread?: string): Promise<boolean> => {
      setIsSending(true);
      setSendError(null);

      try {
        const request: SendMessageRequest = {
          to,
          message: content,
          thread,
        };

        const response = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        });

        const result = await response.json() as { success?: boolean; error?: string };

        if (response.ok && result.success) {
          return true;
        }

        setSendError(result.error || 'Failed to send message');
        return false;
      } catch (error) {
        setSendError('Network error');
        return false;
      } finally {
        setIsSending(false);
      }
    },
    []
  );

  return {
    messages: filteredMessages,
    threadMessages,
    currentChannel,
    setCurrentChannel,
    currentThread,
    setCurrentThread,
    sendMessage,
    isSending,
    sendError,
    ...stats,
  };
}
