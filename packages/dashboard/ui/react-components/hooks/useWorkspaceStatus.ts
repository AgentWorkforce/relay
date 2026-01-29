/**
 * useWorkspaceStatus Hook
 *
 * React hook for monitoring workspace status with auto-wakeup capability.
 * Polls for status updates and can automatically restart stopped workspaces.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { cloudApi } from '../../lib/cloudApi';

export interface WorkspaceStatus {
  id: string;
  name: string;
  status: string;
  publicUrl?: string;
  isStopped: boolean;
  isRunning: boolean;
  isProvisioning: boolean;
  hasError: boolean;
  config: {
    providers: string[];
    repositories: string[];
  };
}

export interface UseWorkspaceStatusOptions {
  /** Poll for status updates (default: true) */
  autoRefresh?: boolean;
  /** Interval to poll for status in ms (default: 30000) */
  refreshInterval?: number;
  /** Auto-wakeup when workspace is stopped (default: false) */
  autoWakeup?: boolean;
  /** Callback when workspace status changes */
  onStatusChange?: (status: string, wasRestarted: boolean) => void;
}

export interface UseWorkspaceStatusReturn {
  /** Current workspace data (null if no workspace) */
  workspace: WorkspaceStatus | null;
  /** Whether workspace exists */
  exists: boolean;
  /** Whether the status check is in progress */
  isLoading: boolean;
  /** Whether a wakeup is in progress */
  isWakingUp: boolean;
  /** Status message for display */
  statusMessage: string;
  /** Action needed (wakeup, check_error, etc) */
  actionNeeded: 'wakeup' | 'check_error' | null;
  /** Error if any */
  error: string | null;
  /** Manually refresh status */
  refresh: () => Promise<void>;
  /** Manually wake up workspace */
  wakeup: () => Promise<{ success: boolean; message: string }>;
}

const DEFAULT_OPTIONS: Required<UseWorkspaceStatusOptions> = {
  autoRefresh: true,
  refreshInterval: 30000, // 30 seconds
  autoWakeup: false,
  onStatusChange: () => {},
};

export function useWorkspaceStatus(
  options: UseWorkspaceStatusOptions = {}
): UseWorkspaceStatusReturn {
  // Stabilize options to prevent infinite re-renders
  // Use refs for callbacks and useMemo for primitive values
  const autoRefresh = options.autoRefresh ?? DEFAULT_OPTIONS.autoRefresh;
  const refreshInterval = options.refreshInterval ?? DEFAULT_OPTIONS.refreshInterval;
  const autoWakeup = options.autoWakeup ?? DEFAULT_OPTIONS.autoWakeup;

  // Store callback in ref to avoid recreating refresh on every render
  const onStatusChangeRef = useRef(options.onStatusChange ?? DEFAULT_OPTIONS.onStatusChange);
  onStatusChangeRef.current = options.onStatusChange ?? DEFAULT_OPTIONS.onStatusChange;

  const [workspace, setWorkspace] = useState<WorkspaceStatus | null>(null);
  const [exists, setExists] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isWakingUp, setIsWakingUp] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [actionNeeded, setActionNeeded] = useState<'wakeup' | 'check_error' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const previousStatusRef = useRef<string | null>(null);

  // Fetch workspace status
  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const result = await cloudApi.getPrimaryWorkspace();

      if (!mountedRef.current) return;

      if (result.success) {
        setExists(result.data.exists);
        setStatusMessage(result.data.statusMessage);
        setActionNeeded(result.data.actionNeeded || null);

        if (result.data.workspace) {
          const ws = result.data.workspace;
          setWorkspace(ws);

          // Check for status change
          if (previousStatusRef.current && previousStatusRef.current !== ws.status) {
            onStatusChangeRef.current(ws.status, false);
          }
          previousStatusRef.current = ws.status;
        } else {
          setWorkspace(null);
        }
      } else {
        setError(result.error);
      }
    } catch (_e) {
      if (mountedRef.current) {
        setError('Failed to fetch workspace status');
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []); // No dependencies - uses refs for callbacks

  // Store refresh interval in ref for wakeup callback
  const refreshIntervalRef = useRef(refreshInterval);
  refreshIntervalRef.current = refreshInterval;
  const autoRefreshRef = useRef(autoRefresh);
  autoRefreshRef.current = autoRefresh;

  // Wake up workspace
  const wakeup = useCallback(async (): Promise<{ success: boolean; message: string }> => {
    if (!workspace?.id) {
      return { success: false, message: 'No workspace to wake up' };
    }

    try {
      setIsWakingUp(true);
      setError(null);

      const result = await cloudApi.wakeupWorkspace(workspace.id);

      if (!mountedRef.current) {
        return { success: false, message: 'Component unmounted' };
      }

      if (result.success) {
        // Update local state
        if (result.data.wasRestarted) {
          setStatusMessage(result.data.message);
          setActionNeeded(null);
          onStatusChangeRef.current('starting', true);

          // Start more frequent polling to catch when workspace is ready
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
          }
          intervalRef.current = setInterval(refresh, 5000); // Poll every 5s during startup

          // Reset to normal interval after 2 minutes
          setTimeout(() => {
            if (mountedRef.current && intervalRef.current) {
              clearInterval(intervalRef.current);
              if (autoRefreshRef.current) {
                intervalRef.current = setInterval(refresh, refreshIntervalRef.current);
              }
            }
          }, 120000);
        }

        return { success: true, message: result.data.message };
      } else {
        setError(result.error);
        return { success: false, message: result.error };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to wake up workspace';
      if (mountedRef.current) {
        setError(message);
      }
      return { success: false, message };
    } finally {
      if (mountedRef.current) {
        setIsWakingUp(false);
      }
    }
  }, [workspace?.id, refresh]);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    refresh();

    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) return;

    intervalRef.current = setInterval(refresh, refreshInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, refreshInterval, refresh]);

  // Auto-wakeup when workspace is stopped
  useEffect(() => {
    if (autoWakeup && workspace?.isStopped && !isWakingUp) {
      wakeup();
    }
  }, [autoWakeup, workspace?.isStopped, isWakingUp, wakeup]);

  return {
    workspace,
    exists,
    isLoading,
    isWakingUp,
    statusMessage,
    actionNeeded,
    error,
    refresh,
    wakeup,
  };
}
