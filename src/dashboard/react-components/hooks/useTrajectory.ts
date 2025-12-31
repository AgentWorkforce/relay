/**
 * useTrajectory Hook
 *
 * Fetches and polls trajectory data from the API.
 * Provides real-time updates on agent work progress.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { TrajectoryStep } from '../TrajectoryViewer';

interface TrajectoryStatus {
  active: boolean;
  trajectoryId?: string;
  phase?: 'plan' | 'design' | 'execute' | 'review' | 'observe';
  task?: string;
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
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useTrajectory(options: UseTrajectoryOptions = {}): UseTrajectoryResult {
  const {
    pollInterval = 2000,
    autoPoll = true,
    trajectoryId,
    apiBaseUrl = '',
  } = options;

  const [steps, setSteps] = useState<TrajectoryStep[]>([]);
  const [status, setStatus] = useState<TrajectoryStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch trajectory status
  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/trajectory`);
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

  // Fetch trajectory steps
  const fetchSteps = useCallback(async () => {
    try {
      const url = trajectoryId
        ? `${apiBaseUrl}/api/trajectory/steps?trajectoryId=${encodeURIComponent(trajectoryId)}`
        : `${apiBaseUrl}/api/trajectory/steps`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.success) {
        setSteps(data.steps || []);
        setError(null);
      } else {
        setError(data.error || 'Failed to fetch trajectory steps');
      }
    } catch (err: any) {
      console.error('[useTrajectory] Steps fetch error:', err);
      setError(err.message);
    }
  }, [apiBaseUrl, trajectoryId]);

  // Combined refresh function
  const refresh = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([fetchStatus(), fetchSteps()]);
    setIsLoading(false);
  }, [fetchStatus, fetchSteps]);

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Polling
  useEffect(() => {
    if (!autoPoll) return;

    pollingRef.current = setInterval(() => {
      fetchSteps();
      fetchStatus();
    }, pollInterval);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [autoPoll, pollInterval, fetchSteps, fetchStatus]);

  return {
    steps,
    status,
    isLoading,
    error,
    refresh,
  };
}

export default useTrajectory;
