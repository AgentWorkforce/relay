/**
 * PostHog configuration.
 *
 * Environment variables (read at runtime):
 *   AGENT_RELAY_POSTHOG_KEY - PostHog write key. Set by published-artifact
 *                              builds via GitHub Actions secret. When unset,
 *                              telemetry runs as a no-op so forks, local dev,
 *                              and CI test runs don't pollute the production
 *                              project.
 *   POSTHOG_API_KEY         - Per-process override (mainly for local
 *                              debugging or staging). Wins over
 *                              `AGENT_RELAY_POSTHOG_KEY` when set.
 *   POSTHOG_HOST            - Override host URL.
 *
 * Key selection order:
 *   1. POSTHOG_API_KEY (process override, any environment)
 *   2. AGENT_RELAY_POSTHOG_KEY (release-time injection)
 *   3. None → returns `null` and `initTelemetry()` becomes a no-op.
 */

const HOST = 'https://us.i.posthog.com';

function readKey(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getPostHogConfig(): { apiKey: string; host: string } | null {
  const host = process.env.POSTHOG_HOST || HOST;

  // Process-level override wins for local debugging / staging swaps.
  const override = readKey('POSTHOG_API_KEY');
  if (override) {
    return { apiKey: override, host };
  }

  // Release-time injection. CI for forks / dev / tests leaves this unset,
  // which intentionally turns telemetry into a no-op.
  const baked = readKey('AGENT_RELAY_POSTHOG_KEY');
  if (baked) {
    return { apiKey: baked, host };
  }

  return null;
}
