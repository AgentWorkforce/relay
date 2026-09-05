const TRUST_MARKER = /\bTRUST_(ACCEPTED|EXITED)\s+layout=(legacy|modern)\b/;
const MAX_OBSERVATION_BYTES = 8_192;

// Accumulate worker-stream chunks until the deterministic Claude model reports
// which trust option was confirmed. PTY frames are transport chunks, not line
// or marker boundaries, so a marker can straddle two frames.
export function createTrustObserver() {
  let output = '';

  return {
    observe(frame) {
      if (frame?.type !== 'worker_stream' || typeof frame.payload?.chunk !== 'string') {
        return undefined;
      }

      output = `${output}${frame.payload.chunk}`.slice(-MAX_OBSERVATION_BYTES);
      const match = TRUST_MARKER.exec(output);
      if (!match) return undefined;

      return { outcome: match[1], layout: match[2], output };
    },
  };
}
