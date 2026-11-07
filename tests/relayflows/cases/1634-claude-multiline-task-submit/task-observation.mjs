const TASK_MARKER = /\b(TASK_(?:STARTED|PARKED|REJECTED))\s+gap_ms=(\d+)\b/;
const MAX_OBSERVATION_BYTES = 4_096;

// Accumulate worker-stream chunks until a complete fake-composer outcome is
// present. PTY frames are transport chunks, not line or marker boundaries.
export function createTaskSubmissionObserver() {
  let output = '';

  return {
    observe(frame) {
      if (frame?.type !== 'worker_stream' || typeof frame.payload?.chunk !== 'string') {
        return undefined;
      }

      output = `${output}${frame.payload.chunk}`.slice(-MAX_OBSERVATION_BYTES);
      const match = TASK_MARKER.exec(output);
      if (!match) return undefined;

      return {
        marker: match[1],
        gapMs: Number(match[2]),
        output,
      };
    },
  };
}
