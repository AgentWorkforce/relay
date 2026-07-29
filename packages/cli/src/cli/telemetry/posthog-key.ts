/**
 * Build-time PostHog write key.
 *
 * The published npm package is plain `tsc` output — there is no bundler step
 * that could inline an env var, and `npm publish --ignore-scripts` rules out a
 * prepublish hook. So the release pipeline rewrites the *compiled* form of this
 * module (`scripts/inject-posthog-key.mjs`) after `npm run build`, and the value
 * ships inside the tarball.
 *
 * The key is a PostHog project ingest key: write-only and public by design, the
 * same category as a Sentry DSN. The Rust broker already ships one via
 * `option_env!`; this is the TypeScript equivalent.
 *
 * Empty here is the correct default — forks, local dev, and CI builds that never
 * run the injection step ship with telemetry disabled.
 */
export const BUILD_TIME_POSTHOG_KEY = '';
