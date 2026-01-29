/**
 * Analytics hook for dashboard components.
 *
 * Provides convenient methods for tracking user interactions,
 * page views, and form submissions using PostHog.
 */

import { useCallback } from 'react';
import {
  trackEvent,
  trackPageView,
  trackUserAction,
  trackFormSubmit,
} from '../../lib/posthog';

export function useAnalytics() {
  const trackPage = useCallback((pagePath: string, pageTitle?: string, isCloudMode = false) => {
    trackPageView(pagePath, pageTitle, isCloudMode);
  }, []);

  const trackAction = useCallback(
    (
      action: string,
      category: 'agent' | 'message' | 'navigation' | 'settings' | 'workspace',
      detail?: string
    ) => {
      trackUserAction(action, category, detail);
    },
    []
  );

  const trackForm = useCallback((formName: string, success: boolean) => {
    trackFormSubmit(formName, success);
  }, []);

  const track = useCallback((event: string, properties?: Record<string, unknown>) => {
    trackEvent(event, properties);
  }, []);

  return { trackPage, trackAction, trackForm, track };
}
