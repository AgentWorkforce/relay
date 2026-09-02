export declare const CANONICAL_FILES: readonly string[];
export declare function prepareRunArtifacts(root: string, runId: string, nonce: string): string;
export declare function markRunArtifactsComplete(artifacts: string, runId: string): void;
export declare function pruneRunArtifacts(
  root: string,
  options?: {
    currentRunId?: string;
    keepCompleted?: number;
    incompleteMaxAgeMs?: number;
    now?: number;
  }
): string[];
