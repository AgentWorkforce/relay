const TRUST_MARKER = /^TRUST_(ACCEPTED|EXITED) layout=(legacy|modern)$/;

// The deterministic Claude model records its decision as a single line in a
// file, and the runner reads it from disk rather than from the worker frame
// stream. That matters: the broker's startup readiness gate rejects an
// onboarding menu, so no `worker_ready` arrives until *after* the trust dialog
// has been answered. An observation keyed on readiness would time out on both
// arms and report an infrastructure failure instead of the behaviour under
// test.
export function parseTrustDecision(contents) {
  if (typeof contents !== 'string') return undefined;
  const match = TRUST_MARKER.exec(contents.trim());
  if (!match) return undefined;
  return { outcome: match[1], layout: match[2] };
}
