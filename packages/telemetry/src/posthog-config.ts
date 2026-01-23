/**
 * PostHog configuration.
 *
 * Environment variables:
 *   POSTHOG_API_KEY     - Override API key (any environment)
 *   POSTHOG_HOST        - Override host URL
 *
 * Key selection:
 *   1. POSTHOG_API_KEY (if set, always used)
 *   3. PROD_API_KEY (fallback)
 */

// =============================================================================
// Configure your PostHog production key here
// =============================================================================

/** Production PostHog API key (write-only, safe for client-side) */
const PROD_API_KEY = 'phc_2uDu01GtnLABJpVkWw4ri1OgScLU90aEmXmDjufGdqr';
const HOST = 'https://us.i.posthog.com';

// =============================================================================
// Exports
// =============================================================================

export function getPostHogConfig(): { apiKey: string; host: string } | null {
  const host = process.env.POSTHOG_HOST || HOST;

  // Explicit override for any environment
  if (process.env.POSTHOG_API_KEY) {
    return { apiKey: process.env.POSTHOG_API_KEY, host };
  }

  // Fallback to production key
  if (!PROD_API_KEY) {
    return null;
  }

  return { apiKey: PROD_API_KEY, host };
}
