export interface SpawnOptions {
  /** Display name for the new OpenClaw (e.g. "researcher"). */
  name: string;
  /** Relay API key for Relaycast messaging. */
  relayApiKey: string;
  /** Channels to auto-join. */
  channels?: string[];
  /** Agent role description. */
  role?: string;
  /** Model reference (e.g. "openai-codex/gpt-5.3-codex"). */
  model?: string;
  /** System prompt / task description. */
  systemPrompt?: string;
  /** Path to an existing workspace directory (for bind-mounting). */
  workspacePath?: string;
  /** Relay base URL (default: https://api.relaycast.dev). */
  relayBaseUrl?: string;
  /** Workspace ID for identity. */
  workspaceId?: string;
}

export interface SpawnHandle {
  /** Unique identifier for this spawn (container ID, process PID, etc). */
  id: string;
  /** The user-provided display name (e.g. "researcher"). Used for lookups. */
  displayName: string;
  /** Relay agent name assigned to this spawn (normalized: claw-<workspace>-<name>). */
  agentName: string;
  /** Gateway port this spawn is listening on. */
  gatewayPort: number;
  /** Destroy (stop + clean up) this spawn. */
  destroy: () => Promise<void>;
}

/**
 * Provider interface for spawning OpenClaw instances.
 * Implementations handle the details of container vs process spawning.
 */
export interface SpawnProvider {
  spawn(options: SpawnOptions): Promise<SpawnHandle>;
  destroy(id: string): Promise<void>;
  list(): Promise<SpawnHandle[]>;
}
