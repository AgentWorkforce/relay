/**
 * PostHog Analytics Provider
 *
 * Wraps the app to initialize PostHog and track page views automatically.
 * Uses the browser SDK (posthog-js) for client-side analytics.
 */

'use client';

import { useEffect, useRef } from 'react';
import { initPostHog, trackPageView, trackSessionStart } from '../lib/posthog';

interface PostHogProviderProps {
  children: React.ReactNode;
}

/**
 * Detects if the dashboard is running in cloud mode.
 */
function isCloudMode(): boolean {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname;
  return (
    hostname.includes('agent-relay.com') ||
    hostname.includes('agentrelay.dev') ||
    hostname.includes('.fly.dev') ||
    localStorage.getItem('agent-relay-cloud-mode') === 'true'
  );
}

export function PostHogProvider({ children }: PostHogProviderProps) {
  const hasTrackedSession = useRef(false);

  useEffect(() => {
    initPostHog();

    if (!hasTrackedSession.current) {
      hasTrackedSession.current = true;
      const cloudMode = isCloudMode();
      trackSessionStart(cloudMode);
      trackPageView(
        window.location.pathname,
        document.title,
        cloudMode
      );
    }
  }, []);

  return <>{children}</>;
}
