/**
 * Hook for fetching and managing workspace repositories
 */

import { useState, useEffect, useCallback } from 'react';

export interface WorkspaceRepo {
  id: string;
  githubFullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  syncStatus: string;
  lastSyncedAt: string | null;
}

export interface UseWorkspaceReposOptions {
  workspaceId?: string;
  apiBaseUrl?: string;
  enabled?: boolean;
}

export interface UseWorkspaceReposReturn {
  repos: WorkspaceRepo[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useWorkspaceRepos({
  workspaceId,
  apiBaseUrl = '/api',
  enabled = true,
}: UseWorkspaceReposOptions): UseWorkspaceReposReturn {
  const [repos, setRepos] = useState<WorkspaceRepo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRepos = useCallback(async () => {
    if (!workspaceId || !enabled) return;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`${apiBaseUrl}/workspaces/${workspaceId}/repos`, {
        credentials: 'include',
      });

      if (!res.ok) {
        throw new Error('Failed to fetch workspace repos');
      }

      const data = await res.json();
      setRepos(data.repositories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch repos');
      console.error('Error fetching workspace repos:', err);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, apiBaseUrl, enabled]);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  return {
    repos,
    isLoading,
    error,
    refetch: fetchRepos,
  };
}
