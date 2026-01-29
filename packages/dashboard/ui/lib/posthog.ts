/**
 * PostHog browser analytics for the dashboard.
 *
 * Uses posthog-js (browser SDK) with the same API key as the server-side
 * telemetry package. Events follow the same snake_case naming conventions
 * defined in @agent-relay/telemetry events.ts.
 */

import posthog from 'posthog-js';

const POSTHOG_API_KEY = 'phc_2uDu01GtnLABJpVkWw4ri1OgScLU90aEmXmDjufGdqr';
const POSTHOG_HOST = 'https://us.i.posthog.com';

let initialized = false;

/**
 * Initialize PostHog for browser-side analytics.
 * Safe to call multiple times; only initializes once.
 */
export function initPostHog(): void {
  if (initialized) return;
  if (typeof window === 'undefined') return;

  posthog.init(POSTHOG_API_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: false, // We handle page views manually
    capture_pageleave: true,
    persistence: 'localStorage',
    autocapture: false, // Explicit tracking only
  });

  initialized = true;
}

/**
 * Track a dashboard event.
 */
export function trackEvent(
  event: string,
  properties?: Record<string, unknown>
): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}

/**
 * Track a page view with dashboard context.
 */
export function trackPageView(
  pagePath: string,
  pageTitle?: string,
  isCloudMode = false
): void {
  trackEvent('dashboard_page_view', {
    page_path: pagePath,
    page_title: pageTitle,
    is_cloud_mode: isCloudMode,
  });
}

/**
 * Track a user action in the dashboard.
 */
export function trackUserAction(
  action: string,
  category: 'agent' | 'message' | 'navigation' | 'settings' | 'workspace',
  detail?: string
): void {
  trackEvent('dashboard_user_action', {
    action,
    category,
    detail,
  });
}

/**
 * Track a form submission.
 */
export function trackFormSubmit(formName: string, success: boolean): void {
  trackEvent('dashboard_form_submit', {
    form_name: formName,
    success,
  });
}

/**
 * Track dashboard session start.
 */
export function trackSessionStart(isCloudMode: boolean): void {
  trackEvent('dashboard_session_start', {
    is_cloud_mode: isCloudMode,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  });
}

/**
 * Identify a user (for cloud mode with authenticated users).
 */
export function identifyUser(userId: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.identify(userId, properties);
}

/**
 * Reset identity (on logout).
 */
export function resetIdentity(): void {
  if (!initialized) return;
  posthog.reset();
}
