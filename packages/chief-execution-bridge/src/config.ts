import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ACTION_SCHEMA } from './protocol.js';

const NAME = z.string().trim().min(1).max(200);
const POSITIVE = z.number().int().positive();
const HOUR_MS = 3_600_000;

/**
 * Non-secret operator configuration. The worker's Relay token is injected through the
 * environment at runtime and never appears here or in the ledger.
 */
export const configSchema = z
  .strictObject({
    relayOrigin: z.string().url(),
    /** Control's workspace: the one assignments carry. */
    workspaceId: NAME,
    /** Relay names workspaces separately from Control. Omitted when both use one identifier. */
    relayWorkspaceId: NAME.optional(),
    worker: z.strictObject({ agentId: NAME, address: z.string().regex(/^[^\s@]+@[^\s@]+$/) }),
    chief: z.strictObject({
      agentId: NAME,
      address: z.string().regex(/^[^\s@]+@[^\s@]+$/),
      chiefId: NAME,
      organizationId: NAME,
      projectId: NAME,
    }),
    /** `owner/repo` to the absolute working folder. Assignments can never name a folder. */
    repositories: z
      .record(
        z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
        z.string().refine(isAbsolute, 'must be absolute')
      )
      .refine((r) => Object.keys(r).length > 0, 'at least one repository is required'),
    actions: z.array(ACTION_SCHEMA).min(1),
    maxEvidenceAgeMs: POSITIVE.max(86_400_000),
    /** Only harnesses whose final answer the core can return to the requester. */
    harness: z.enum(['claude', 'codex']),
    node: z.strictObject({ id: NAME, name: NAME }),
    /**
     * Operator attestation that the node is dedicated to this bridge and was started
     * with a scrubbed environment and HOME holding no person's credentials or MCP
     * servers. The native spawn API cannot enforce this per task. Both must be `true`.
     */
    isolation: z.strictObject({
      dedicatedNode: z.literal(true),
      scrubbedEnvironment: z.literal(true),
    }),
    limits: z.strictObject({
      maxConcurrent: POSITIVE.max(32),
      /** The most one assignment may reserve. */
      maxReservationMicros: POSITIVE.max(Number.MAX_SAFE_INTEGER),
      /** Lifetime total of reservations this ledger will admit. Not metered spend. */
      budgetMicros: POSITIVE.max(Number.MAX_SAFE_INTEGER),
      maxRuntimeMs: POSITIVE.max(24 * HOUR_MS),
      maxQueuedMs: POSITIVE.max(24 * HOUR_MS),
    }),
    ledgerPath: z.string().refine(isAbsolute, 'must be absolute'),
    coreSocket: z.string().refine(isAbsolute, 'must be absolute').optional(),
    pollIntervalMs: POSITIVE.min(1000).max(300_000).default(5000),
  })
  .superRefine((config, ctx) => {
    if (config.worker.agentId === config.chief.agentId) {
      ctx.addIssue({ code: 'custom', message: 'The chief cannot be the execution worker' });
    }
    const origin = new URL(config.relayOrigin);
    const loopback = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) {
      ctx.addIssue({ code: 'custom', message: 'relayOrigin must be https (or http on loopback)' });
    }
    if (origin.origin !== config.relayOrigin.replace(/\/$/, '')) {
      ctx.addIssue({ code: 'custom', message: 'relayOrigin must be a bare origin' });
    }
  });

export type BridgeConfig = z.infer<typeof configSchema>;

/**
 * @param config The workspace identifiers from the configuration.
 * @returns The workspace Relay must report for the worker's token.
 */
export function relayWorkspaceOf(config: Pick<BridgeConfig, 'workspaceId' | 'relayWorkspaceId'>): string {
  return config.relayWorkspaceId ?? config.workspaceId;
}
