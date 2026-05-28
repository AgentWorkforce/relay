import type { RelayfileChangeEvent } from '@agent-relay/events';

/**
 * A workspace file the bridge read from the gateway, normalized to a path plus
 * a parsed body (JSON-decoded when the content looked like JSON, else the raw
 * string).
 */
export interface WorkspaceFileLike {
  /** VFS path of the file. */
  path: string;
  /** Parsed body — an object/array when the content was JSON, else a string. */
  body: unknown;
}

/**
 * Context handed to {@link ProviderAdapter.resolveInbound} for a single change.
 */
export interface InboundContext {
  /**
   * Stable, filename-safe identifier the bridge minted for this inbound item.
   * Providers should embed it in their reply path so the agent's outbox file
   * (`<replyId>.md`) maps back to the write target.
   */
  replyId: string;
}

/**
 * An actionable inbound item derived from a provider change event.
 */
export interface InboundItem {
  /** Short human label for the source surface, e.g. `#ops` or `ENG-123`. */
  source: string;
  /** Human-readable body injected into the agent as the message content. */
  body: string;
  /**
   * VFS path the agent's reply should be written to. Writing this path triggers
   * the provider's relayfile writeback (e.g. Slack `chat.postMessage`).
   */
  replyPath: string;
  /**
   * Serialize the agent's raw reply text into VFS file content for `replyPath`.
   * @param replyText - The plain-text reply the agent wrote to its outbox.
   */
  serializeReply(replyText: string): { content: string; contentType: string };
}

/**
 * A provider integration the bridge can route. Each adapter owns the knowledge
 * of how that provider's inbound events and writeback paths are shaped, keeping
 * the core bridge provider-agnostic.
 */
export interface ProviderAdapter {
  /** Provider name; matches the relayfile path root and event provider, e.g. `slack`. */
  readonly name: string;
  /** Watch globs registered with the gateway, e.g. `['/slack/channels/**']`. */
  readonly watch: string[];
  /**
   * Decide whether a relayfile change is an actionable inbound item.
   *
   * Return `null` to ignore the change — used for the bridge's own writeback
   * echoes, non-message paths, and bot/self messages that would otherwise loop.
   *
   * @param event - The normalized `relayfile.changed` event.
   * @param file - The changed file's content (already read), or `null` if it
   *   could not be read.
   * @param ctx - Per-item context, including the minted `replyId`.
   */
  resolveInbound(
    event: RelayfileChangeEvent,
    file: WorkspaceFileLike | null,
    ctx: InboundContext
  ): InboundItem | null;
}
