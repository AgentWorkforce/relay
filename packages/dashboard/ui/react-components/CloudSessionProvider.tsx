/**
 * Cloud Session Provider
 *
 * Wraps the dashboard app to provide cloud session management.
 * Automatically detects session expiration and prompts re-login.
 *
 * Usage:
 * ```tsx
 * <CloudSessionProvider>
 *   <App />
 * </CloudSessionProvider>
 * ```
 */

import React, { createContext, useContext, useCallback } from 'react';
import { useSession, type UseSessionReturn, type SessionError } from './hooks/useSession';
import { SessionExpiredModal } from './SessionExpiredModal';

// Context type
interface CloudSessionContextValue extends UseSessionReturn {
  /** Whether this is a cloud-hosted dashboard */
  isCloudMode: boolean;
}

// Create context with undefined default
const CloudSessionContext = createContext<CloudSessionContextValue | undefined>(undefined);

export interface CloudSessionProviderProps {
  /** Child components */
  children: React.ReactNode;
  /** Whether this dashboard is running in cloud mode (default: auto-detect) */
  cloudMode?: boolean;
  /** Session check interval in ms (default: 60000) */
  checkInterval?: number;
  /** Callback when session expires */
  onSessionExpired?: (error: SessionError) => void;
}

/**
 * Auto-detect if running in cloud mode
 * Cloud mode is detected by checking for cloud-specific environment markers
 */
function detectCloudMode(): boolean {
  if (typeof window === 'undefined') return false;

  // Check for cloud URL patterns
  const hostname = window.location.hostname;
  if (hostname.includes('agent-relay.com')) return true;
  if (hostname.includes('agentrelay.cloud')) return true;

  // Check for cloud mode flag in meta tags
  const cloudMeta = document.querySelector('meta[name="agent-relay-cloud"]');
  if (cloudMeta?.getAttribute('content') === 'true') return true;

  // Check for cloud mode in local storage (for development)
  if (localStorage.getItem('agent-relay-cloud-mode') === 'true') return true;

  return false;
}

export function CloudSessionProvider({
  children,
  cloudMode,
  checkInterval = 60000,
  onSessionExpired,
}: CloudSessionProviderProps) {
  const isCloudMode = cloudMode ?? detectCloudMode();

  // Use session hook only in cloud mode
  const session = useSession({
    checkOnMount: isCloudMode,
    checkInterval: isCloudMode ? checkInterval : 0,
    onExpired: onSessionExpired,
  });

  // Handle login redirect
  const handleLogin = useCallback(() => {
    session.redirectToLogin();
  }, [session]);

  // Handle modal dismiss (optional - keeps modal closable for some use cases)
  const handleDismiss = useCallback(() => {
    session.clearExpired();
  }, [session]);

  // Context value
  const contextValue: CloudSessionContextValue = {
    ...session,
    isCloudMode,
  };

  return (
    <CloudSessionContext.Provider value={contextValue}>
      {children}

      {/* Session Expired Modal - only shown in cloud mode */}
      {isCloudMode && (
        <SessionExpiredModal
          isOpen={session.isExpired}
          error={session.error}
          onLogin={handleLogin}
          onDismiss={handleDismiss}
        />
      )}
    </CloudSessionContext.Provider>
  );
}

/**
 * Hook to access cloud session context
 *
 * @throws Error if used outside of CloudSessionProvider
 */
export function useCloudSession(): CloudSessionContextValue {
  const context = useContext(CloudSessionContext);
  if (!context) {
    throw new Error('useCloudSession must be used within a CloudSessionProvider');
  }
  return context;
}

/**
 * Hook to optionally access cloud session context
 * Returns undefined if not within a CloudSessionProvider
 */
export function useCloudSessionOptional(): CloudSessionContextValue | undefined {
  return useContext(CloudSessionContext);
}

export default CloudSessionProvider;
