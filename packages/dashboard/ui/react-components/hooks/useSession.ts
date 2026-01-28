/**
 * useSession Hook
 *
 * React hook for managing cloud session state.
 * Automatically detects session expiration and triggers re-login flow.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  cloudApi,
  onSessionExpired,
  getCsrfToken,
  type CloudUser,
  type SessionError,
  type SessionStatus,
} from '../../lib/cloudApi';

export interface UseSessionOptions {
  /** Check session on mount (default: true) */
  checkOnMount?: boolean;
  /** Interval to periodically check session in ms (default: 60000, set to 0 to disable) */
  checkInterval?: number;
  /** Callback when session expires */
  onExpired?: (error: SessionError) => void;
}

export interface UseSessionReturn {
  /** Current user data (null if not authenticated) */
  user: CloudUser | null;
  /** Whether the session check is in progress */
  isLoading: boolean;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Whether session has expired (requires re-login) */
  isExpired: boolean;
  /** Session error if any */
  error: SessionError | null;
  /** CSRF token for API requests */
  csrfToken: string | null;
  /** Manually check session status */
  checkSession: () => Promise<SessionStatus>;
  /** Clear the expired state (e.g., after dismissing modal) */
  clearExpired: () => void;
  /** Redirect to login page */
  redirectToLogin: () => void;
  /** Logout the current user */
  logout: () => Promise<void>;
}

const DEFAULT_OPTIONS: Required<UseSessionOptions> = {
  checkOnMount: true,
  checkInterval: 60000, // 1 minute
  onExpired: () => {},
};

export function useSession(options: UseSessionOptions = {}): UseSessionReturn {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const [user, setUser] = useState<CloudUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpired, setIsExpired] = useState(false);
  const [error, setError] = useState<SessionError | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);

  // Check session status
  const checkSession = useCallback(async (): Promise<SessionStatus> => {
    try {
      const status = await cloudApi.checkSession();

      if (!mountedRef.current) return status;

      if (!status.authenticated) {
        setUser(null);
        if (status.code) {
          const sessionError: SessionError = {
            error: 'Session expired',
            code: status.code,
            message: status.message || 'Your session has expired. Please log in again.',
          };
          setError(sessionError);
          setIsExpired(true);
          opts.onExpired(sessionError);
        }
      }

      return status;
    } catch (_e) {
      return {
        authenticated: false,
        code: 'SESSION_ERROR',
        message: 'Failed to check session',
      };
    }
  }, [opts]);

  // Fetch user data
  const fetchUser = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await cloudApi.getMe();

      if (!mountedRef.current) return;

      if (result.success) {
        setUser(result.data);
        setIsExpired(false);
        setError(null);
      } else if (result.sessionExpired) {
        setUser(null);
        setIsExpired(true);
      } else {
        setError({
          error: result.error,
          code: 'SESSION_ERROR',
          message: result.error,
        });
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Handle session expiration from any API call
  useEffect(() => {
    const unsubscribe = onSessionExpired((sessionError) => {
      if (!mountedRef.current) return;

      setUser(null);
      setIsExpired(true);
      setError(sessionError);
      opts.onExpired(sessionError);
    });

    return unsubscribe;
  }, [opts]);

  // Check session on mount
  useEffect(() => {
    mountedRef.current = true;

    if (opts.checkOnMount) {
      fetchUser();
    }

    return () => {
      mountedRef.current = false;
    };
  }, [opts.checkOnMount, fetchUser]);

  // Periodic session check
  useEffect(() => {
    if (opts.checkInterval <= 0) return;

    intervalRef.current = setInterval(() => {
      // Only check if we think we're authenticated
      if (user) {
        checkSession();
      }
    }, opts.checkInterval);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [opts.checkInterval, user, checkSession]);

  // Clear expired state
  const clearExpired = useCallback(() => {
    setIsExpired(false);
    setError(null);
  }, []);

  // Redirect to login
  const redirectToLogin = useCallback(() => {
    // Preserve current path for redirect after login
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?returnTo=${returnTo}`;
  }, []);

  // Logout
  const logout = useCallback(async () => {
    await cloudApi.logout();
    setUser(null);
    setIsExpired(false);
    setError(null);
    window.location.href = '/login';
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: user !== null,
    isExpired,
    error,
    csrfToken: getCsrfToken(),
    checkSession,
    clearExpired,
    redirectToLogin,
    logout,
  };
}

export type { SessionError, CloudUser };
