/**
 * useChannelAdmin Hook
 *
 * Manages channel administration: settings, members, and permissions.
 * Used by ChannelAdminPanel for admin-only operations.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../../lib/api';

export interface ChannelMemberInfo {
  id: string;
  name: string;
  displayName?: string;
  avatarUrl?: string;
  role: 'admin' | 'member';
  joinedAt: string;
  isAgent: boolean;
}

export interface ChannelSettings {
  id: string;
  name: string;
  description?: string;
  topic?: string;
  isPrivate: boolean;
  createdAt: string;
  creatorId: string;
  admins: string[];
}

export interface UseChannelAdminOptions {
  /** Channel ID to manage */
  channelId: string;
  /** Current user ID for permission checks */
  currentUserId?: string;
  /** Page size for member pagination (default: 20) */
  pageSize?: number;
  /** Auto-fetch on mount (default: true) */
  autoFetch?: boolean;
}

export interface UseChannelAdminReturn {
  /** Channel settings */
  settings: ChannelSettings | null;
  /** List of members for current page */
  members: ChannelMemberInfo[];
  /** Loading states */
  isLoadingSettings: boolean;
  isLoadingMembers: boolean;
  /** Error messages */
  settingsError: string | null;
  membersError: string | null;
  /** Whether current user is admin */
  isAdmin: boolean;
  /** Member pagination */
  memberPage: number;
  memberTotalPages: number;
  memberTotalCount: number;
  goToMemberPage: (page: number) => void;
  /** Member search */
  memberSearchQuery: string;
  setMemberSearchQuery: (query: string) => void;
  /** Update channel settings */
  updateSettings: (updates: Partial<Pick<ChannelSettings, 'description' | 'topic'>>) => Promise<void>;
  /** Remove a member from channel */
  removeMember: (memberId: string) => Promise<void>;
  /** Assign an agent to the channel */
  assignAgent: (agentName: string) => Promise<void>;
  /** Promote/demote member to/from admin */
  setMemberRole: (memberId: string, role: 'admin' | 'member') => Promise<void>;
  /** Refresh data */
  refreshSettings: () => void;
  refreshMembers: () => void;
}

export function useChannelAdmin(
  options: UseChannelAdminOptions
): UseChannelAdminReturn {
  const {
    channelId,
    currentUserId,
    pageSize = 20,
    autoFetch = true,
  } = options;

  // Settings state
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Members state
  const [members, setMembers] = useState<ChannelMemberInfo[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberPage, setMemberPage] = useState(1);
  const [memberTotalCount, setMemberTotalCount] = useState(0);
  const [memberSearchQuery, setMemberSearchQuery] = useState('');

  // Calculate admin status
  const isAdmin = useMemo(() => {
    if (!currentUserId || !settings) return false;
    return settings.creatorId === currentUserId || settings.admins.includes(currentUserId);
  }, [currentUserId, settings]);

  // Calculate total pages
  const memberTotalPages = useMemo(() => {
    return Math.max(1, Math.ceil(memberTotalCount / pageSize));
  }, [memberTotalCount, pageSize]);

  // Fetch channel settings
  const fetchSettings = useCallback(async () => {
    setIsLoadingSettings(true);
    setSettingsError(null);

    try {
      const result = await api.get<{
        channel: ChannelSettings;
        currentUserRole: 'admin' | 'member' | null;
      }>(`/api/channels/${channelId}`);

      if (result.channel) {
        setSettings(result.channel);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch channel settings';
      setSettingsError(message);
      console.error('[useChannelAdmin] Settings fetch error:', err);
    } finally {
      setIsLoadingSettings(false);
    }
  }, [channelId]);

  // Fetch channel members
  const fetchMembers = useCallback(async (page: number, search: string) => {
    setIsLoadingMembers(true);
    setMembersError(null);

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: pageSize.toString(),
      });

      if (search.trim()) {
        params.set('search', search.trim());
      }

      const result = await api.get<{
        members: ChannelMemberInfo[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      }>(`/api/channels/${channelId}/members?${params.toString()}`);

      if (result.members) {
        setMembers(result.members);
        setMemberTotalCount(result.pagination?.total || result.members.length);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch members';
      setMembersError(message);
      console.error('[useChannelAdmin] Members fetch error:', err);
    } finally {
      setIsLoadingMembers(false);
    }
  }, [channelId, pageSize]);

  // Auto-fetch on mount or channelId change
  useEffect(() => {
    if (autoFetch && channelId) {
      fetchSettings();
      fetchMembers(1, '');
    }
  }, [autoFetch, channelId, fetchSettings, fetchMembers]);

  // Fetch members when page or search changes
  useEffect(() => {
    if (autoFetch && channelId) {
      fetchMembers(memberPage, memberSearchQuery);
    }
  }, [memberPage, memberSearchQuery, autoFetch, channelId, fetchMembers]);

  // Reset to page 1 when search changes
  useEffect(() => {
    setMemberPage(1);
  }, [memberSearchQuery]);

  // Go to specific member page
  const goToMemberPage = useCallback((page: number) => {
    const validPage = Math.max(1, Math.min(page, memberTotalPages));
    setMemberPage(validPage);
  }, [memberTotalPages]);

  // Update channel settings
  const updateSettings = useCallback(async (updates: Partial<Pick<ChannelSettings, 'description' | 'topic'>>) => {
    if (!isAdmin) {
      throw new Error('Permission denied: Admin access required');
    }

    try {
      await api.patch(`/api/channels/${channelId}`, updates);

      // Optimistically update local state
      setSettings((prev) => prev ? { ...prev, ...updates } : null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update settings';
      setSettingsError(message);
      throw err;
    }
  }, [channelId, isAdmin]);

  // Remove a member
  const removeMember = useCallback(async (memberId: string) => {
    if (!isAdmin) {
      throw new Error('Permission denied: Admin access required');
    }

    try {
      await api.delete(`/api/channels/${channelId}/members/${memberId}`);

      // Optimistically update local state
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
      setMemberTotalCount((prev) => Math.max(0, prev - 1));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove member';
      setMembersError(message);
      throw err;
    }
  }, [channelId, isAdmin]);

  // Assign an agent to the channel
  const assignAgent = useCallback(async (agentName: string) => {
    if (!isAdmin) {
      throw new Error('Permission denied: Admin access required');
    }

    try {
      const result = await api.post<{ member: ChannelMemberInfo }>(`/api/channels/${channelId}/agents`, {
        agentName,
      });

      // Add to members list if returned
      if (result.member) {
        setMembers((prev) => [...prev, result.member]);
        setMemberTotalCount((prev) => prev + 1);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to assign agent';
      setMembersError(message);
      throw err;
    }
  }, [channelId, isAdmin]);

  // Set member role
  const setMemberRole = useCallback(async (memberId: string, role: 'admin' | 'member') => {
    if (!isAdmin) {
      throw new Error('Permission denied: Admin access required');
    }

    try {
      await api.patch(`/api/channels/${channelId}/members/${memberId}`, { role });

      // Optimistically update local state
      setMembers((prev) =>
        prev.map((m) => m.id === memberId ? { ...m, role } : m)
      );

      // Update admins list in settings
      if (role === 'admin') {
        setSettings((prev) => {
          if (!prev) return null;
          const member = members.find((m) => m.id === memberId);
          if (member && !prev.admins.includes(member.name)) {
            return { ...prev, admins: [...prev.admins, member.name] };
          }
          return prev;
        });
      } else {
        setSettings((prev) => {
          if (!prev) return null;
          const member = members.find((m) => m.id === memberId);
          if (member) {
            return { ...prev, admins: prev.admins.filter((a) => a !== member.name) };
          }
          return prev;
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update member role';
      setMembersError(message);
      throw err;
    }
  }, [channelId, isAdmin, members]);

  // Refresh functions
  const refreshSettings = useCallback(() => {
    fetchSettings();
  }, [fetchSettings]);

  const refreshMembers = useCallback(() => {
    fetchMembers(memberPage, memberSearchQuery);
  }, [fetchMembers, memberPage, memberSearchQuery]);

  return {
    settings,
    members,
    isLoadingSettings,
    isLoadingMembers,
    settingsError,
    membersError,
    isAdmin,
    memberPage,
    memberTotalPages,
    memberTotalCount,
    goToMemberPage,
    memberSearchQuery,
    setMemberSearchQuery,
    updateSettings,
    removeMember,
    assignAgent,
    setMemberRole,
    refreshSettings,
    refreshMembers,
  };
}
