// Single source of truth for the decision vocabulary. The probe interpolates
// these same constants into its source, so the marker the probe writes and the
// marker this parser accepts cannot drift apart. Divergence would surface as a
// proof timeout — reported as an infrastructure failure — rather than as a
// verdict about the broker.
export const TRUST_ACCEPTED = 'TRUST_ACCEPTED';
export const TRUST_EXITED = 'TRUST_EXITED';
export const TRUST_LAYOUTS = ['modern', 'legacy'];

const TRUST_MARKER = new RegExp(`^(${TRUST_ACCEPTED}|${TRUST_EXITED}) layout=(${TRUST_LAYOUTS.join('|')})$`);

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
