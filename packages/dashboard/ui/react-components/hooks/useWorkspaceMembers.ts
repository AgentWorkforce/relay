/**
 * useWorkspaceMembers Hook
 *
 * Fetches and caches workspace members for filtering online users.
 * Returns the set of usernames that have access to the workspace.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { cloudApi } from '../../lib/cloudApi';
import type { UserPresence } from './usePresence';

interface WorkspaceMember {
  id: string;
  userId: string;
  role: string;
  isPending: boolean;
  user?: {
    githubUsername: string;
    email?: string;
    avatarUrl?: string;
  };
}

export interface UseWorkspaceMembersOptions {
  /** The workspace ID to fetch members for */
  workspaceId?: string;
  /** Whether to enable fetching (e.g., only in cloud mode) */
  enabled?: boolean;
}

export interface UseWorkspaceMembersReturn {
  /** Set of usernames with workspace access (lowercase for comparison) */
  memberUsernames: Set<string>;
  /** Whether members are currently loading */
  isLoading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** Refetch workspace members */
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch workspace members and provide a set of usernames with access.
 * Used to filter online users to show only those with workspace access.
 */
export function useWorkspaceMembers(
  options: UseWorkspaceMembersOptions = {}
): UseWorkspaceMembersReturn {
  const { workspaceId, enabled = true } = options;

  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMembers = useCallback(async () => {
    if (!workspaceId || !enabled) {
      setMembers([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await cloudApi.getWorkspaceMembers(workspaceId);
      if (result.success) {
        setMembers(result.data.members as WorkspaceMember[]);
      } else {
        setError(result.error);
        setMembers([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch members');
      setMembers([]);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, enabled]);

  // Fetch members when workspace changes
  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  // Build set of member usernames (lowercase for case-insensitive comparison)
  const memberUsernames = useMemo(() => {
    const usernames = new Set<string>();
    for (const member of members) {
      if (member.user?.githubUsername) {
        usernames.add(member.user.githubUsername.toLowerCase());
      }
    }
    return usernames;
  }, [members]);

  return {
    memberUsernames,
    isLoading,
    error,
    refetch: fetchMembers,
  };
}

/**
 * Filter online users to only include those with workspace access.
 * If no members are loaded (non-cloud mode or error), returns all users.
 */
export function filterOnlineUsersByWorkspace(
  onlineUsers: UserPresence[],
  memberUsernames: Set<string>
): UserPresence[] {
  // If no members loaded, show all users (non-cloud mode fallback)
  if (memberUsernames.size === 0) {
    return onlineUsers;
  }

  return onlineUsers.filter((user) =>
    memberUsernames.has(user.username.toLowerCase())
  );
}
