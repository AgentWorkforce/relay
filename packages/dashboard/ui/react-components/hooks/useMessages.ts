/**
 * useMessages Hook
 *
 * React hook for managing message state with filtering,
 * threading, and send functionality.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import type { Message, SendMessageRequest } from '../../types';
import { api } from '../../lib/api';

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

  // Effective sender name for the current user (used for filtering own messages)
  const effectiveSenderName = senderName || 'Dashboard';

  // Optimistic messages: shown immediately before server confirms
  // These have status='sending' and a temp ID prefixed with 'optimistic-'
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);

  // Clean up optimistic messages when they appear in the real messages list
  // Match by to + content only (not from, since server may use different sender like '_DashboardUI')
  useEffect(() => {
    if (optimisticMessages.length === 0) return;

    // Create a set of "fingerprints" for real messages (recent ones only)
    // Use to + content only - the 'from' field may differ between optimistic (user's name)
    // and real message (server may use '_DashboardUI' as relay client name)
    const recentMessages = messages.slice(-50); // Only check recent messages for performance
    const realFingerprints = new Set(
      recentMessages.map((m) => `${m.to}:${m.content.slice(0, 100)}`)
    );

    // Remove optimistic messages that now exist in real messages
    setOptimisticMessages((prev) =>
      prev.filter((opt) => {
        const fingerprint = `${opt.to}:${opt.content.slice(0, 100)}`;
        return !realFingerprints.has(fingerprint);
      })
    );
  }, [messages, optimisticMessages.length]);

  // Combine real messages with optimistic messages
  const allMessages = useMemo(() => {
    if (optimisticMessages.length === 0) return messages;
    // Append optimistic messages at the end (they're the most recent)
    return [...messages, ...optimisticMessages];
  }, [messages, optimisticMessages]);

  // Filter messages by current channel
  // Only exclude reply-chain replies (where thread is another message's ID)
  // Keep topic thread messages (where thread is a topic name, not a message ID)
  const filteredMessages = useMemo(() => {
    // Build set of message IDs for efficient lookup
    const messageIds = new Set(allMessages.map((m) => m.id));

    // Filter out reply-chain replies (thread points to existing message ID)
    // Keep topic thread messages (thread is a name, not a message ID)
    const mainViewMessages = allMessages.filter((m) => {
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
  }, [allMessages, currentChannel]);

  // Get messages for a specific thread
  const threadMessages = useCallback(
    (threadId: string) => allMessages.filter((m) => m.thread === threadId),
    [allMessages]
  );

  // Calculate active threads with unread counts
  const activeThreads = useMemo((): ThreadInfo[] => {
    const threadMap = new Map<string, Message[]>();
    const messageIds = new Set(allMessages.map((m) => m.id));

    // Group messages by thread
    for (const msg of allMessages) {
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
      // Exclude messages from current user - users shouldn't get notifications for their own messages
      const seenTimestamp = seenThreads.get(threadId);
      const unreadCount = threadMsgs.filter((m) => {
        if (m.from === effectiveSenderName) return false; // Don't count own messages as unread
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
        const originalMsg = allMessages.find((m) => m.id === threadId);
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
  }, [allMessages, seenThreads]);

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
    const unread = allMessages.filter((m) => !m.isRead).length;
    return {
      totalCount: allMessages.length,
      unreadCount: unread,
    };
  }, [allMessages]);

  // Send message function with optimistic updates
  const sendMessage = useCallback(
    async (to: string, content: string, thread?: string, attachmentIds?: string[]): Promise<boolean> => {
      setIsSending(true);
      setSendError(null);

      // Create optimistic message and add it immediately for snappy UX
      const from = effectiveSenderName;
      const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const optimisticMsg: Message = {
        id: optimisticId,
        from,
        to,
        content,
        timestamp: new Date().toISOString(),
        status: 'sending',
        thread,
        isRead: true, // User's own messages are always "read"
      };

      // Add optimistic message immediately - UI updates instantly
      setOptimisticMessages((prev) => [...prev, optimisticMsg]);

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

        // Use api.sendMessage which handles:
        // - Workspace proxy routing (in cloud mode)
        // - CSRF token headers
        // - Credentials
        const result = await api.sendMessage(request);

        if (result.success) {
          // Success! The optimistic message will be cleaned up when
          // the real message arrives via WebSocket
          return true;
        }

        // Failed - remove the optimistic message and show error
        setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        setSendError(result.error || 'Failed to send message');
        return false;
      } catch (_error) {
        // Network error - remove optimistic message
        setOptimisticMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        setSendError('Network error');
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [effectiveSenderName, senderName]
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
