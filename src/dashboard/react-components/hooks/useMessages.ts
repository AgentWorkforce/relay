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
  /** Optional sender name for cloud mode (GitHub username). Falls back to 'Dashboard' if not provided. */
  senderName?: string;
}

export interface ThreadInfo {
  id: string;
  name: string;
  lastMessage: Message;
  messageCount: number;
  unreadCount: number;
  participants: string[];
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

  // Thread info
  activeThreads: ThreadInfo[];
  totalUnreadThreadCount: number;

  // Message actions
  sendMessage: (to: string, content: string, thread?: string, attachmentIds?: string[]) => Promise<boolean>;
  isSending: boolean;
  sendError: string | null;

  // Stats
  totalCount: number;
  unreadCount: number;
}

export function useMessages({
  messages,
  currentChannel: initialChannel = 'general',
  senderName,
}: UseMessagesOptions): UseMessagesReturn {
  const [currentChannel, setCurrentChannel] = useState(initialChannel);
  const [currentThreadInternal, setCurrentThreadInternal] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Track seen threads with timestamp of when they were last viewed
  // This allows us to show new messages that arrive after viewing
  const [seenThreads, setSeenThreads] = useState<Map<string, number>>(new Map());

  // Filter messages by current channel
  // Only exclude reply-chain replies (where thread is another message's ID)
  // Keep topic thread messages (where thread is a topic name, not a message ID)
  const filteredMessages = useMemo(() => {
    // Build set of message IDs for efficient lookup
    const messageIds = new Set(messages.map((m) => m.id));

    // Filter out reply-chain replies (thread points to existing message ID)
    // Keep topic thread messages (thread is a name, not a message ID)
    const mainViewMessages = messages.filter((m) => {
      if (!m.thread) return true; // No thread - show it
      // If thread is a message ID, it's a reply - hide it from main view
      // If thread is a topic name, show it
      return !messageIds.has(m.thread);
    });

    if (currentChannel === 'general') {
      return mainViewMessages;
    }
    return mainViewMessages.filter(
      (m) => m.from === currentChannel || m.to === currentChannel
    );
  }, [messages, currentChannel]);

  // Get messages for a specific thread
  const threadMessages = useCallback(
    (threadId: string) => messages.filter((m) => m.thread === threadId),
    [messages]
  );

  // Calculate active threads with unread counts
  const activeThreads = useMemo((): ThreadInfo[] => {
    const threadMap = new Map<string, Message[]>();
    const messageIds = new Set(messages.map((m) => m.id));

    // Group messages by thread
    for (const msg of messages) {
      if (msg.thread) {
        const existing = threadMap.get(msg.thread) || [];
        existing.push(msg);
        threadMap.set(msg.thread, existing);
      }
    }

    // Convert to ThreadInfo array
    const threads: ThreadInfo[] = [];
    for (const [threadId, threadMsgs] of threadMap.entries()) {
      // Sort by timestamp to get the last message
      const sorted = [...threadMsgs].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      // Get unique participants
      const participants = [...new Set(threadMsgs.flatMap((m) => [m.from, m.to]))].filter(
        (p) => p !== '*'
      );

      // Count unread messages in thread
      // Consider messages as "read" if they arrived before we last viewed this thread
      // Exclude messages from "Dashboard" - users shouldn't get notifications for their own messages
      const seenTimestamp = seenThreads.get(threadId);
      const unreadCount = threadMsgs.filter((m) => {
        if (m.from === 'Dashboard') return false; // Don't count own messages as unread
        if (m.isRead) return false; // Already marked as read
        if (seenTimestamp) {
          // If we've seen this thread, only count messages after that time
          return new Date(m.timestamp).getTime() > seenTimestamp;
        }
        return true; // Not seen yet, count as unread
      }).length;

      // Determine thread name: if threadId is a message ID, use first message content as name
      let name = threadId;
      if (messageIds.has(threadId)) {
        // Find the original message that started the thread
        const originalMsg = messages.find((m) => m.id === threadId);
        if (originalMsg) {
          // Use first line of content, truncated
          const firstLine = originalMsg.content.split('\n')[0];
          name = firstLine.length > 30 ? firstLine.substring(0, 30) + '...' : firstLine;
        }
      }

      threads.push({
        id: threadId,
        name,
        lastMessage: sorted[0],
        messageCount: threadMsgs.length,
        unreadCount,
        participants,
      });
    }

    // Sort by last activity (most recent first)
    return threads.sort(
      (a, b) =>
        new Date(b.lastMessage.timestamp).getTime() - new Date(a.lastMessage.timestamp).getTime()
    );
  }, [messages, seenThreads]);

  // Wrapper for setCurrentThread that also marks the thread as seen
  const setCurrentThread = useCallback((threadId: string | null) => {
    setCurrentThreadInternal(threadId);
    if (threadId) {
      // Mark thread as seen with current timestamp
      setSeenThreads((prev) => {
        const next = new Map(prev);
        next.set(threadId, Date.now());
        return next;
      });
    }
  }, []);

  // Calculate total unread threads
  const totalUnreadThreadCount = useMemo(
    () => activeThreads.filter((t) => t.unreadCount > 0).length,
    [activeThreads]
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
    async (to: string, content: string, thread?: string, attachmentIds?: string[]): Promise<boolean> => {
      setIsSending(true);
      setSendError(null);

      try {
        const request: SendMessageRequest & { from?: string } = {
          to,
          message: content,
          thread,
          attachments: attachmentIds,
        };

        // Include sender name for cloud mode (GitHub username)
        if (senderName) {
          request.from = senderName;
        }

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
      } catch (_error) {
        setSendError('Network error');
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [senderName]
  );

  return {
    messages: filteredMessages,
    threadMessages,
    currentChannel,
    setCurrentChannel,
    currentThread: currentThreadInternal,
    setCurrentThread,
    activeThreads,
    totalUnreadThreadCount,
    sendMessage,
    isSending,
    sendError,
    ...stats,
  };
}
