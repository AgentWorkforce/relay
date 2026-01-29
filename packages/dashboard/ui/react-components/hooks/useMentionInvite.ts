/**
 * useMentionInvite Hook
 *
 * Manages the @mention channel invite flow:
 * 1. When a message with @mentions is sent, checks if mentioned users are channel members
 * 2. For non-members in public channels, sends invite notifications
 * 3. Provides UI state for showing invite notifications and pending invites
 * 4. Handles accepting/declining invites
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  MentionInvite,
  SendMentionInviteResponse,
} from '../channels/types';
import {
  processMentionInvites,
  getMentionInvites,
  respondToMentionInvite,
  sendMentionInvite,
} from '../channels/api';

export interface MentionInviteNotification {
  /** The invite details */
  invite: MentionInvite;
  /** Whether the notification has been seen */
  seen: boolean;
}

export interface UseMentionInviteOptions {
  /** Current workspace ID */
  workspaceId?: string;
  /** Current username */
  currentUser?: string;
  /** Polling interval for checking new invites (ms). Set to 0 to disable. */
  pollInterval?: number;
  /** Callback when invites are sent after a mention */
  onInvitesSent?: (results: SendMentionInviteResponse[], nonMembers: string[]) => void;
  /** Callback when an invite is received */
  onInviteReceived?: (invite: MentionInvite) => void;
  /** Callback when an invite is accepted (user joined channel) */
  onInviteAccepted?: (channelId: string) => void;
}

export interface UseMentionInviteReturn {
  /** Pending invites for the current user */
  pendingInvites: MentionInvite[];
  /** Whether currently processing mentions */
  isProcessing: boolean;
  /** Whether currently loading invites */
  isLoading: boolean;
  /** Last error message */
  error: string | null;
  /** Process @mentions in a sent message and invite non-members */
  processMessageMentions: (channelId: string, messageContent: string, mentions: string[]) => Promise<void>;
  /** Send a single invite to a user for a channel */
  inviteUserToChannel: (channelId: string, username: string, messageContent?: string) => Promise<SendMentionInviteResponse>;
  /** Accept a pending invite */
  acceptInvite: (inviteId: string) => Promise<boolean>;
  /** Decline a pending invite */
  declineInvite: (inviteId: string) => Promise<boolean>;
  /** Refresh the list of pending invites */
  refreshInvites: () => Promise<void>;
  /** Number of unseen invite notifications */
  unseenCount: number;
  /** Mark all invites as seen */
  markAllSeen: () => void;
}

/**
 * Extract @mentions from message content.
 * Returns array of usernames (without the @ prefix).
 */
export function extractMentions(content: string): string[] {
  const mentionRegex = /@(\w[\w.-]*)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(content)) !== null) {
    const name = match[1];
    // Skip broadcast/special mentions
    if (name !== 'everyone' && name !== 'here' && name !== 'channel') {
      mentions.push(name);
    }
  }

  // Deduplicate
  return Array.from(new Set(mentions));
}

export function useMentionInvite(options: UseMentionInviteOptions = {}): UseMentionInviteReturn {
  const {
    workspaceId,
    currentUser,
    pollInterval = 30000,
    onInvitesSent,
    onInviteReceived,
    onInviteAccepted,
  } = options;

  const [pendingInvites, setPendingInvites] = useState<MentionInvite[]>([]);
  const [seenInviteIds, setSeenInviteIds] = useState<Set<string>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onInvitesSentRef = useRef(onInvitesSent);
  const onInviteReceivedRef = useRef(onInviteReceived);
  const onInviteAcceptedRef = useRef(onInviteAccepted);
  onInvitesSentRef.current = onInvitesSent;
  onInviteReceivedRef.current = onInviteReceived;
  onInviteAcceptedRef.current = onInviteAccepted;

  const refreshInvites = useCallback(async () => {
    if (!currentUser) return;
    setIsLoading(true);
    try {
      const response = await getMentionInvites(workspaceId);
      const newInvites = response.invites;

      // Check for newly received invites
      setPendingInvites(prev => {
        const prevIds = new Set(prev.map(i => i.id));
        const newOnes = newInvites.filter(i => !prevIds.has(i.id));
        for (const invite of newOnes) {
          onInviteReceivedRef.current?.(invite);
        }
        return newInvites;
      });

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invites');
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, currentUser]);

  // Poll for new invites
  useEffect(() => {
    if (!currentUser || pollInterval <= 0) return;

    refreshInvites();
    const interval = setInterval(refreshInvites, pollInterval);
    return () => clearInterval(interval);
  }, [currentUser, pollInterval, refreshInvites]);

  const processMessageMentions = useCallback(async (
    channelId: string,
    messageContent: string,
    mentions: string[]
  ) => {
    if (!workspaceId || mentions.length === 0) return;

    setIsProcessing(true);
    setError(null);

    try {
      const result = await processMentionInvites(
        workspaceId,
        channelId,
        messageContent,
        mentions
      );

      if (result.errors.length > 0) {
        setError(`Some invites failed: ${result.errors.join(', ')}`);
      }

      if (result.invitesSent.length > 0) {
        onInvitesSentRef.current?.(result.invitesSent, result.nonMembers);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process mentions');
    } finally {
      setIsProcessing(false);
    }
  }, [workspaceId]);

  const inviteUserToChannel = useCallback(async (
    channelId: string,
    username: string,
    messageContent?: string
  ): Promise<SendMentionInviteResponse> => {
    if (!workspaceId) {
      return { success: false, error: 'No workspace ID' };
    }

    setIsProcessing(true);
    setError(null);

    try {
      const result = await sendMentionInvite(workspaceId, channelId, username, messageContent);
      if (!result.success && result.error) {
        setError(result.error);
      }
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to send invite';
      setError(errorMsg);
      return { success: false, error: errorMsg };
    } finally {
      setIsProcessing(false);
    }
  }, [workspaceId]);

  const acceptInvite = useCallback(async (inviteId: string): Promise<boolean> => {
    if (!workspaceId) return false;

    try {
      const result = await respondToMentionInvite(workspaceId, inviteId, 'accept');
      if (result.success) {
        setPendingInvites(prev => prev.filter(i => i.id !== inviteId));
        if (result.channelId) {
          onInviteAcceptedRef.current?.(result.channelId);
        }
        return true;
      }
      setError(result.error || 'Failed to accept invite');
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept invite');
      return false;
    }
  }, [workspaceId]);

  const declineInvite = useCallback(async (inviteId: string): Promise<boolean> => {
    if (!workspaceId) return false;

    try {
      const result = await respondToMentionInvite(workspaceId, inviteId, 'decline');
      if (result.success) {
        setPendingInvites(prev => prev.filter(i => i.id !== inviteId));
        return true;
      }
      setError(result.error || 'Failed to decline invite');
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decline invite');
      return false;
    }
  }, [workspaceId]);

  const unseenCount = pendingInvites.filter(i => !seenInviteIds.has(i.id)).length;

  const markAllSeen = useCallback(() => {
    setSeenInviteIds(new Set(pendingInvites.map(i => i.id)));
  }, [pendingInvites]);

  return {
    pendingInvites,
    isProcessing,
    isLoading,
    error,
    processMessageMentions,
    inviteUserToChannel,
    acceptInvite,
    declineInvite,
    refreshInvites,
    unseenCount,
    markAllSeen,
  };
}
