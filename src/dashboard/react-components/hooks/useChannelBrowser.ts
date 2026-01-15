/**
 * useChannelBrowser Hook
 *
 * Manages browsing, searching, and joining channels.
 * Includes debounced search and pagination support.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useDebounce } from './useDebounce';
import { api } from '../../lib/api';

export interface BrowseChannel {
  id: string;
  name: string;
  description?: string;
  memberCount: number;
  isJoined: boolean;
  isPrivate: boolean;
  createdAt: string;
}

export interface UseChannelBrowserOptions {
  /** Workspace ID (required for API calls) */
  workspaceId: string;
  /** Initial page size (default: 20) */
  pageSize?: number;
  /** Search debounce delay in ms (default: 300) */
  debounceDelay?: number;
  /** Auto-fetch on mount (default: true) */
  autoFetch?: boolean;
}

export interface UseChannelBrowserReturn {
  /** List of channels for current page */
  channels: BrowseChannel[];
  /** Loading state */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Current search query */
  searchQuery: string;
  /** Update search query */
  setSearchQuery: (query: string) => void;
  /** Current page (1-indexed) */
  currentPage: number;
  /** Total number of pages */
  totalPages: number;
  /** Total count of channels matching search */
  totalCount: number;
  /** Navigate to a specific page */
  goToPage: (page: number) => void;
  /** Join a channel */
  joinChannel: (channelId: string) => Promise<void>;
  /** Leave a channel */
  leaveChannel: (channelId: string) => Promise<void>;
  /** Refresh the channel list */
  refresh: () => void;
}

export function useChannelBrowser(
  options: UseChannelBrowserOptions
): UseChannelBrowserReturn {
  const {
    workspaceId,
    pageSize = 20,
    debounceDelay = 300,
    autoFetch = true,
  } = options;

  const [channels, setChannels] = useState<BrowseChannel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  // Debounce search query
  const debouncedSearchQuery = useDebounce(searchQuery, debounceDelay);

  // Calculate total pages
  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(totalCount / pageSize));
  }, [totalCount, pageSize]);

  // Fetch channels from API (workspace-scoped)
  const fetchChannels = useCallback(async (page: number, search: string) => {
    if (!workspaceId) {
      setError('Workspace ID is required');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Build query params
      const params = new URLSearchParams({
        page: page.toString(),
        limit: pageSize.toString(),
      });

      if (search.trim()) {
        params.set('search', search.trim());
      }

      // Use workspace-scoped endpoint
      const result = await api.get<{
        channels: Array<{
          id: string;
          name: string;
          description?: string;
          memberCount?: number;
          isPrivate?: boolean;
          createdAt: string;
          // Backend may use different field names
          isMember?: boolean;
        }>;
        archivedChannels?: unknown[];
        pagination?: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
      }>(`/api/workspaces/${workspaceId}/channels?${params.toString()}`);

      if (result.channels) {
        // Map backend response to BrowseChannel format
        const mappedChannels: BrowseChannel[] = result.channels.map((ch) => ({
          id: ch.id,
          name: ch.name,
          description: ch.description,
          memberCount: ch.memberCount || 0,
          isJoined: ch.isMember ?? false,
          isPrivate: ch.isPrivate ?? false,
          createdAt: ch.createdAt,
        }));
        setChannels(mappedChannels);
        setTotalCount(result.pagination?.total || result.channels.length);
      } else {
        // API might return different structure - handle gracefully
        setChannels([]);
        setTotalCount(0);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch channels';
      setError(message);
      console.error('[useChannelBrowser] Fetch error:', err);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, pageSize]);

  // Fetch when search or page changes
  useEffect(() => {
    if (autoFetch) {
      fetchChannels(currentPage, debouncedSearchQuery);
    }
  }, [currentPage, debouncedSearchQuery, autoFetch, fetchChannels]);

  // Reset to page 1 when search changes
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchQuery]);

  // Go to specific page
  const goToPage = useCallback((page: number) => {
    const validPage = Math.max(1, Math.min(page, totalPages));
    setCurrentPage(validPage);
  }, [totalPages]);

  // Join a channel (workspace-scoped)
  const joinChannel = useCallback(async (channelId: string) => {
    if (!workspaceId) {
      throw new Error('Workspace ID is required');
    }

    try {
      await api.post(`/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/join`);

      // Optimistically update local state
      setChannels((prev) =>
        prev.map((ch) =>
          ch.id === channelId
            ? { ...ch, isJoined: true, memberCount: ch.memberCount + 1 }
            : ch
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to join channel';
      setError(message);
      throw err;
    }
  }, [workspaceId]);

  // Leave a channel (workspace-scoped)
  const leaveChannel = useCallback(async (channelId: string) => {
    if (!workspaceId) {
      throw new Error('Workspace ID is required');
    }

    try {
      await api.post(`/api/workspaces/${workspaceId}/channels/${encodeURIComponent(channelId)}/leave`);

      // Optimistically update local state
      setChannels((prev) =>
        prev.map((ch) =>
          ch.id === channelId
            ? { ...ch, isJoined: false, memberCount: Math.max(0, ch.memberCount - 1) }
            : ch
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to leave channel';
      setError(message);
      throw err;
    }
  }, [workspaceId]);

  // Refresh current view
  const refresh = useCallback(() => {
    fetchChannels(currentPage, debouncedSearchQuery);
  }, [fetchChannels, currentPage, debouncedSearchQuery]);

  return {
    channels,
    isLoading,
    error,
    searchQuery,
    setSearchQuery,
    currentPage,
    totalPages,
    totalCount,
    goToPage,
    joinChannel,
    leaveChannel,
    refresh,
  };
}
