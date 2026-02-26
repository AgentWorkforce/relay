/**
 * Shadow agent support for the broker SDK.
 *
 * A shadow agent monitors all messages to/from a primary agent.
 * Implemented SDK-side using the event hook system — no broker
 * protocol extension required.
 *
 * @example
 * ```ts
 * import { AgentRelay, ShadowManager } from "agent-relay/broker";
 *
 * const relay = new AgentRelay();
 * const shadows = new ShadowManager();
 *
 * // Bind "Reviewer" as shadow of "Worker1"
 * shadows.bind("Reviewer", "Worker1");
 *
 * // Wire into relay events
 * relay.onMessageReceived = (msg) => {
 *   const copies = shadows.intercept(msg.from, msg.to, msg);
 *   for (const copy of copies) {
 *     // Forward shadow copies to the shadow agent
 *     relay.human({ name: "system" }).sendMessage({
 *       to: copy.shadowAgent,
 *       text: `[Shadow of ${copy.primaryAgent}] ${msg.text}`,
 *     });
 *   }
 * };
 * ```
 */

import type { SpeakOnTrigger } from '@agent-relay/config';

// ── Types ────────────────────────────────────────────────────────────────────

// Re-export from config to maintain backwards compatibility
export type { SpeakOnTrigger };

export interface ShadowConfig {
  primaryAgent: string;
  speakOn: SpeakOnTrigger[];
  receiveIncoming: boolean;
  receiveOutgoing: boolean;
}

export interface ShadowRelationship extends ShadowConfig {
  shadowAgent: string;
}

export interface ShadowCopy {
  shadowAgent: string;
  primaryAgent: string;
  direction: 'incoming' | 'outgoing';
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class ShadowManager {
  /** primaryAgent → list of shadow relationships */
  private shadowsByPrimary = new Map<string, ShadowRelationship[]>();
  /** shadowAgent → primaryAgent (reverse lookup) */
  private primaryByShadow = new Map<string, string>();

  /**
   * Bind a shadow agent to monitor a primary agent.
   */
  bind(
    shadowAgent: string,
    primaryAgent: string,
    options: {
      speakOn?: SpeakOnTrigger[];
      receiveIncoming?: boolean;
      receiveOutgoing?: boolean;
    } = {}
  ): void {
    // Clean up any existing binding for this shadow
    this.unbind(shadowAgent);

    const relationship: ShadowRelationship = {
      shadowAgent,
      primaryAgent,
      speakOn: options.speakOn ?? ['EXPLICIT_ASK'],
      receiveIncoming: options.receiveIncoming ?? true,
      receiveOutgoing: options.receiveOutgoing ?? true,
    };

    let shadows = this.shadowsByPrimary.get(primaryAgent);
    if (!shadows) {
      shadows = [];
      this.shadowsByPrimary.set(primaryAgent, shadows);
    }
    shadows.push(relationship);
    this.primaryByShadow.set(shadowAgent, primaryAgent);
  }

  /**
   * Unbind a shadow from its primary.
   */
  unbind(shadowAgent: string): void {
    const primaryAgent = this.primaryByShadow.get(shadowAgent);
    if (!primaryAgent) return;

    const shadows = this.shadowsByPrimary.get(primaryAgent);
    if (shadows) {
      const updated = shadows.filter((s) => s.shadowAgent !== shadowAgent);
      if (updated.length === 0) {
        this.shadowsByPrimary.delete(primaryAgent);
      } else {
        this.shadowsByPrimary.set(primaryAgent, updated);
      }
    }
    this.primaryByShadow.delete(shadowAgent);
  }

  /**
   * Get all shadows for a primary agent.
   */
  getShadowsFor(primaryAgent: string): ShadowRelationship[] {
    return this.shadowsByPrimary.get(primaryAgent) ?? [];
  }

  /**
   * Get the primary agent a shadow is bound to.
   */
  getPrimaryFor(shadowAgent: string): string | undefined {
    return this.primaryByShadow.get(shadowAgent);
  }

  /**
   * Check whether a shadow should speak for a given trigger.
   */
  shouldSpeak(shadowAgent: string, trigger: SpeakOnTrigger): boolean {
    const primary = this.primaryByShadow.get(shadowAgent);
    if (!primary) return true; // not a shadow, always speaks

    const shadows = this.shadowsByPrimary.get(primary);
    if (!shadows) return true;

    const rel = shadows.find((s) => s.shadowAgent === shadowAgent);
    if (!rel) return true;

    return rel.speakOn.includes(trigger) || rel.speakOn.includes('ALL_MESSAGES');
  }

  /**
   * Determine which shadows should receive a copy of a message
   * between `from` and `to`. Returns a list of shadow copies to deliver.
   *
   * Call this from your `onMessageReceived` / `onMessageSent` hooks
   * to fan out shadow copies.
   */
  intercept(from: string, to: string): ShadowCopy[] {
    const copies: ShadowCopy[] = [];

    // Outgoing shadows of the sender
    const senderShadows = this.shadowsByPrimary.get(from);
    if (senderShadows) {
      for (const s of senderShadows) {
        if (s.receiveOutgoing && s.shadowAgent !== to) {
          copies.push({
            shadowAgent: s.shadowAgent,
            primaryAgent: from,
            direction: 'outgoing',
          });
        }
      }
    }

    // Incoming shadows of the recipient
    if (to && to !== '*') {
      const recipientShadows = this.shadowsByPrimary.get(to);
      if (recipientShadows) {
        for (const s of recipientShadows) {
          if (s.receiveIncoming && s.shadowAgent !== from) {
            copies.push({
              shadowAgent: s.shadowAgent,
              primaryAgent: to,
              direction: 'incoming',
            });
          }
        }
      }
    }

    return copies;
  }

  /**
   * Emit a trigger event and return shadow agents that should be notified.
   *
   * Use this to implement `speakOn` behavior — when a trigger fires
   * (e.g. CODE_WRITTEN, REVIEW_REQUEST), call this to find which
   * shadows should receive a notification.
   */
  emitTrigger(primaryAgent: string, trigger: SpeakOnTrigger): string[] {
    const shadows = this.shadowsByPrimary.get(primaryAgent) ?? [];
    return shadows
      .filter((s) => s.speakOn.includes(trigger) || s.speakOn.includes('ALL_MESSAGES'))
      .map((s) => s.shadowAgent);
  }

  /**
   * List all current shadow bindings.
   */
  listBindings(): ShadowRelationship[] {
    const all: ShadowRelationship[] = [];
    for (const shadows of this.shadowsByPrimary.values()) {
      all.push(...shadows);
    }
    return all;
  }

  /**
   * Remove all bindings (for shutdown).
   */
  clear(): void {
    this.shadowsByPrimary.clear();
    this.primaryByShadow.clear();
  }
}
