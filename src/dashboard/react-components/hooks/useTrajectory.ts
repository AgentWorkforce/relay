/**
 * useTrajectory Hook
 *
 * Fetches and polls trajectory data from the API.
 * Provides real-time updates on agent work progress.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TrajectoryStep } from '../TrajectoryViewer';
import { getApiUrl } from '../../lib/api';

interface TrajectoryStatus {
  active: boolean;
  trajectoryId?: string;
  phase?: 'plan' | 'design' | 'execute' | 'review' | 'observe';
  task?: string;
}

export interface TrajectoryHistoryEntry {
  id: string;
  title: string;
  status: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt?: string;
  agents?: string[];
  summary?: string;
  confidence?: number;
}

interface UseTrajectoryOptions {
  /** Polling interval in ms (default: 2000) */
  pollInterval?: number;
  /** Whether to auto-poll (default: true) */
  autoPoll?: boolean;
  /** Specific trajectory ID to fetch */
  trajectoryId?: string;
  /** API base URL (for when running outside default context) */
  apiBaseUrl?: string;
}

interface UseTrajectoryResult {
  steps: TrajectoryStep[];
  status: TrajectoryStatus | null;
  history: TrajectoryHistoryEntry[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  selectTrajectory: (id: string | null) => void;
  selectedTrajectoryId: string | null;
}

export function useTrajectory(options: UseTrajectoryOptions = {}): UseTrajectoryResult {
  const {
    pollInterval = 2000,
    autoPoll = true,
    trajectoryId: initialTrajectoryId,
    apiBaseUrl = '',
  } = options;

  const [steps, setSteps] = useState<TrajectoryStep[]>([]);
  const [status, setStatus] = useState<TrajectoryStatus | null>(null);
  const [history, setHistory] = useState<TrajectoryHistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrajectoryId, setSelectedTrajectoryId] = useState<string | null>(initialTrajectoryId || null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const hasLoadedInitialStepsRef = useRef(false);
  const hasInitializedRef = useRef(false);
  // Track the latest selection to prevent stale fetches from overwriting data
  const latestSelectionRef = useRef<string | null>(selectedTrajectoryId);
  // Request counter to ensure only the most recent fetch updates state
  // This is more robust than trajectory ID comparison for handling race conditions
  const requestCounterRef = useRef(0);

  // Fetch trajectory status
  const fetchStatus = useCallback(async () => {
    try {
      // Use apiBaseUrl if provided, otherwise use getApiUrl for cloud mode routing
      const url = apiBaseUrl
        ? `${apiBaseUrl}/api/trajectory`
        : getApiUrl('/api/trajectory');
      const response = await fetch(url, { credentials: 'include' });
      const data = await response.json();

      if (data.success !== false) {
        setStatus({
          active: data.active,
          trajectoryId: data.trajectoryId,
          phase: data.phase,
          task: data.task,
        });
      }
    } catch (err: any) {
      console.error('[useTrajectory] Status fetch error:', err);
    }
  }, [apiBaseUrl]);

  // Fetch trajectory history
  const fetchHistory = useCallback(async () => {
    try {
      const url = apiBaseUrl
        ? `${apiBaseUrl}/api/trajectory/history`
        : getApiUrl('/api/trajectory/history');
      const response = await fetch(url, { credentials: 'include' });
      const data = await response.json();

      if (data.success) {
        setHistory(data.trajectories || []);
      }
    } catch (err: any) {
      console.error('[useTrajectory] History fetch error:', err);
    }
  }, [apiBaseUrl]);

  // Fetch trajectory steps
  const fetchSteps = useCallback(async () => {
    // Increment request counter and capture it for this request
    // This ensures only the most recent request updates state
    const requestId = ++requestCounterRef.current;
    const trajectoryId = selectedTrajectoryId;

    try {
      const basePath = trajectoryId
        ? `/api/trajectory/steps?trajectoryId=${encodeURIComponent(trajectoryId)}`
        : '/api/trajectory/steps';
      const url = apiBaseUrl
        ? `${apiBaseUrl}${basePath}`
        : getApiUrl(basePath);

      const response = await fetch(url, { credentials: 'include' });
      const data = await response.json();

      // Only update state if this is still the most recent request
      // Check both request counter AND trajectory ID for double protection
      if (requestId !== requestCounterRef.current) {
        console.log('[useTrajectory] Ignoring superseded fetch (request', requestId, 'current', requestCounterRef.current, ')');
        return;
      }
      if (trajectoryId !== latestSelectionRef.current) {
        console.log('[useTrajectory] Ignoring stale fetch for', trajectoryId, 'current is', latestSelectionRef.current);
        return;
      }

      if (data.success) {
        setSteps(data.steps || []);
        setError(null);
      } else {
        setError(data.error || 'Failed to fetch trajectory steps');
      }
    } catch (err: any) {
      // Only update error state if this is still the current request
      if (requestId === requestCounterRef.current && trajectoryId === latestSelectionRef.current) {
        console.error('[useTrajectory] Steps fetch error:', err);
        setError(err.message);
      }
    }
  }, [apiBaseUrl, selectedTrajectoryId]);

  // Select a specific trajectory
  const selectTrajectory = useCallback((id: string | null) => {
    // Normalize empty string to null for consistency
    const normalizedId = id === '' ? null : id;

    // Skip if already selected (prevents unnecessary re-fetches)
    if (normalizedId === selectedTrajectoryId) {
      return;
    }

    // Increment request counter to invalidate any in-flight fetches immediately
    // This is crucial - it ensures that even if an old fetch completes after this,
    // its request ID won't match and it will be ignored
    requestCounterRef.current++;

    // Update the ref immediately so in-flight fetches for other trajectories are ignored
    latestSelectionRef.current = normalizedId;

    // Clear steps immediately when switching trajectories to prevent showing stale data
    setSteps([]);

    // Set loading immediately to avoid flash of empty state before effect runs
    if (normalizedId !== null) {
      setIsLoading(true);
    }
    setSelectedTrajectoryId(normalizedId);
  }, [selectedTrajectoryId]);

  // Combined refresh function
  const refresh = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([fetchStatus(), fetchSteps(), fetchHistory()]);
    setIsLoading(false);
  }, [fetchStatus, fetchSteps, fetchHistory]);

  // Keep the latestSelectionRef in sync with state
  // This handles the initial value and any external changes
  // Note: selectedTrajectoryId is already normalized by selectTrajectory
  useEffect(() => {
    latestSelectionRef.current = selectedTrajectoryId;
  }, [selectedTrajectoryId]);

  // Initial fetch - only run once on mount
  // Note: Empty deps array is intentional - we use hasInitializedRef to ensure single execution
  useEffect(() => {
    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;
    refresh();
  }, [refresh]);

  // Re-fetch steps when selected trajectory changes
  // Note: Initial fetch is handled by the refresh() call in the mount effect
  useEffect(() => {
    // Skip the initial render - refresh() handles it
    if (!hasLoadedInitialStepsRef.current) {
      hasLoadedInitialStepsRef.current = true;
      return;
    }

    // For subsequent selection changes, fetch with loading state management
    let cancelled = false;
    setIsLoading(true);
    fetchSteps().finally(() => {
      if (!cancelled) {
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedTrajectoryId, fetchSteps]);

  // Polling
  useEffect(() => {
    if (!autoPoll) return;

    pollingRef.current = setInterval(() => {
      fetchSteps();
      fetchStatus();
      // Poll history less frequently
    }, pollInterval);

    // Poll history every 10 seconds
    const historyPollRef = setInterval(fetchHistory, 10000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
      clearInterval(historyPollRef);
    };
  }, [autoPoll, pollInterval, fetchSteps, fetchStatus, fetchHistory]);

  return {
    steps,
    status,
    history,
    isLoading,
    error,
    refresh,
    selectTrajectory,
    selectedTrajectoryId,
  };
}

export default useTrajectory;
