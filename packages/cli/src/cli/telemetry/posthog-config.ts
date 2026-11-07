/**
 * PostHog configuration.
 *
 * Key selection order:
 *   1. `POSTHOG_API_KEY`         — per-process override (local debugging,
 *                                  staging swaps). Wins everywhere.
 *   2. `AGENT_RELAY_POSTHOG_KEY` — runtime env, and the name the bun standalone
 *                                  build substitutes via `--define`.
 *   3. `BUILD_TIME_POSTHOG_KEY`  — baked into the published npm tarball by
 *                                  `scripts/inject-posthog-key.mjs`.
 *   4. None → returns `null` and `initTelemetry()` becomes a no-op, which is
 *      what forks, local dev, and CI runs get.
 *
 * `POSTHOG_HOST` overrides the ingestion host; it defaults to the hosted Agent
 * Relay proxy.
 *
 * ## The env reads must stay literal
 *
 * These MUST remain static `process.env.NAME` member expressions. The bun
 * `--define` used for the standalone binary performs a *syntactic* substitution
 * of exactly `process.env.AGENT_RELAY_POSTHOG_KEY`; a computed lookup such as
 * `process.env[name]` is a different expression and is silently left alone. An
 * earlier `readKey(name: string)` helper did exactly that, so every standalone
 * binary shipped with telemetry permanently disabled even though the define was
 * present in the release workflow. Do not refactor these back behind a variable.
 */

import { BUILD_TIME_POSTHOG_KEY } from './posthog-key.js';

const HOST = 'https://i.agentrelay.com';

function nonEmpty(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getPostHogConfig(): { apiKey: string; host: string } | null {
  const host = process.env.POSTHOG_HOST || HOST;

  // Process-level override wins for local debugging / staging swaps.
  const override = nonEmpty(process.env.POSTHOG_API_KEY);
  if (override) {
    return { apiKey: override, host };
  }

  // Runtime env, and the bun standalone's `--define` target. Literal access —
  // see the module comment.
  const injected = nonEmpty(process.env.AGENT_RELAY_POSTHOG_KEY);
  if (injected) {
    return { apiKey: injected, host };
  }

  // Baked into the published npm artifact at release time.
  const baked = nonEmpty(BUILD_TIME_POSTHOG_KEY);
  if (baked) {
    return { apiKey: baked, host };
  }

  return null;
}
