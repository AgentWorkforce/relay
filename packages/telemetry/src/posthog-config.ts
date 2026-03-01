/**
 * PostHog configuration.
 *
 * Environment variables:
 *   POSTHOG_API_KEY   - Runtime override
 *   POSTHOG_HOST      - Runtime host override
 *
 * Key selection:
 *   1. POSTHOG_API_KEY (runtime override)
 *   2. BUILD_POSTHOG_API_KEY (injected during official publish builds)
 */

import {
  BUILD_POSTHOG_API_KEY,
  BUILD_POSTHOG_HOST,
} from './posthog-build-config.js';

// =============================================================================
// Exports
// =============================================================================

export function getPostHogConfig(): { apiKey: string; host: string } | null {
  const host = process.env.POSTHOG_HOST ||
    BUILD_POSTHOG_HOST ||
    'https://us.i.posthog.com';

  const runtimeApiKey = process.env.POSTHOG_API_KEY;

  if (runtimeApiKey) {
    return { apiKey: runtimeApiKey, host };
  }

  if (!BUILD_POSTHOG_API_KEY) {
    return null;
  }

  return { apiKey: BUILD_POSTHOG_API_KEY, host };
}
