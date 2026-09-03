export declare function prepareRunWorktree(
  repoRoot: string,
  workspaceRoot: string,
  runId: string,
  options?: { timeoutMs?: number }
): Promise<string>;
export declare function removeRunWorktree(
  repoRoot: string,
  worktree: string,
  options?: { timeoutMs?: number }
): Promise<void>;
