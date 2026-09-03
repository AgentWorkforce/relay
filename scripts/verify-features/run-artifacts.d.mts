export declare const CANONICAL_FILES: readonly string[];
/**
 * Creates private run storage, then publishes the entire run through one
 * canonical `current` symlink. POSIX replacement is atomic; Windows uses a
 * bounded remove/rename retry because it cannot replace an existing symlink.
 */
export declare function prepareRunArtifacts(
  root: string,
  runId: string,
  nonce: string,
  options?: { platform?: NodeJS.Platform }
): string;
export declare function markRunArtifactsComplete(artifacts: string, runId: string): void;
/**
 * Keeps the newest completed runs, gives incomplete runs a seven-day default
 * grace period, and never removes the current canonical target. Concurrent
 * pruning races that lose a target with ENOENT are intentionally benign.
 */
export declare function pruneRunArtifacts(
  root: string,
  options?: {
    currentRunId?: string;
    keepCompleted?: number;
    incompleteMaxAgeMs?: number;
    now?: number;
  }
): string[];
