/**
 * useRecentRepos Hook
 *
 * Tracks and persists recently accessed repositories/projects.
 * Stores in localStorage for persistence across sessions.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Project } from '../../types';

const STORAGE_KEY = 'relay:recentRepos';
const MAX_RECENT = 5;

export interface RecentRepo {
  id: string;
  path: string;
  name?: string;
  lastAccessed: number;
}

export interface UseRecentReposOptions {
  /** Maximum number of recent repos to track (default: 5) */
  maxRecent?: number;
}

export interface UseRecentReposReturn {
  /** List of recent repos, most recent first */
  recentRepos: RecentRepo[];
  /** Add or update a repo in recent list */
  addRecentRepo: (project: Project) => void;
  /** Remove a repo from recent list */
  removeRecentRepo: (id: string) => void;
  /** Clear all recent repos */
  clearRecentRepos: () => void;
  /** Get recent repos as Project-like objects for display */
  getRecentProjects: (allProjects: Project[]) => Project[];
}

/**
 * Load recent repos from localStorage
 */
function loadRecentRepos(): RecentRepo[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Save recent repos to localStorage
 */
function saveRecentRepos(repos: RecentRepo[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(repos));
  } catch {
    // Silently fail if localStorage is not available
  }
}

export function useRecentRepos(options: UseRecentReposOptions = {}): UseRecentReposReturn {
  const maxRecent = options.maxRecent ?? MAX_RECENT;
  const [recentRepos, setRecentRepos] = useState<RecentRepo[]>([]);

  // Load from localStorage on mount
  useEffect(() => {
    setRecentRepos(loadRecentRepos());
  }, []);

  // Add or update a repo in recent list
  const addRecentRepo = useCallback((project: Project) => {
    setRecentRepos((prev) => {
      // Remove if already exists
      const filtered = prev.filter((r) => r.id !== project.id);

      // Add to front with current timestamp
      const newRepo: RecentRepo = {
        id: project.id,
        path: project.path,
        name: project.name,
        lastAccessed: Date.now(),
      };

      // Keep only maxRecent items
      const updated = [newRepo, ...filtered].slice(0, maxRecent);

      // Persist to localStorage
      saveRecentRepos(updated);

      return updated;
    });
  }, [maxRecent]);

  // Remove a repo from recent list
  const removeRecentRepo = useCallback((id: string) => {
    setRecentRepos((prev) => {
      const updated = prev.filter((r) => r.id !== id);
      saveRecentRepos(updated);
      return updated;
    });
  }, []);

  // Clear all recent repos
  const clearRecentRepos = useCallback(() => {
    setRecentRepos([]);
    saveRecentRepos([]);
  }, []);

  // Get recent repos as Project objects (matched against current projects)
  const getRecentProjects = useCallback((allProjects: Project[]): Project[] => {
    const projectMap = new Map(allProjects.map((p) => [p.id, p]));
    return recentRepos
      .map((r) => projectMap.get(r.id))
      .filter((p): p is Project => p !== undefined);
  }, [recentRepos]);

  return {
    recentRepos,
    addRecentRepo,
    removeRecentRepo,
    clearRecentRepos,
    getRecentProjects,
  };
}

export default useRecentRepos;
