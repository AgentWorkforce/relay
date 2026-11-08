import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { actionSchema } from './protocol.js';

const name = z.string().trim().min(1).max(200);
const positive = z.number().int().positive();
const HOUR_MS = 3_600_000;

/**
 * Non-secret operator configuration. The worker's Relay token is injected through the
 * environment at runtime and never appears here or in the ledger.
 */
export const configSchema = z
  .strictObject({
    relayOrigin: z.string().url(),
    workspaceId: name,
    worker: z.strictObject({ agentId: name, address: z.string().regex(/^[^\s@]+@[^\s@]+$/) }),
    chief: z.strictObject({
      agentId: name,
      address: z.string().regex(/^[^\s@]+@[^\s@]+$/),
      chiefId: name,
      organizationId: name,
      projectId: name,
    }),
    /** `owner/repo` to the absolute working folder. Assignments can never name a folder. */
    repositories: z
      .record(
        z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/),
        z.string().refine(isAbsolute, 'must be absolute')
      )
      .refine((r) => Object.keys(r).length > 0, 'at least one repository is required'),
    actions: z.array(actionSchema).min(1),
    maxEvidenceAgeMs: positive.max(86_400_000),
    /** Only harnesses whose final answer the core can return to the requester. */
    harness: z.enum(['claude', 'codex']),
    node: z.strictObject({ id: name, name: name }),
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
      maxConcurrent: positive.max(32),
      /** The most one assignment may reserve. */
      maxReservationMicros: positive.max(Number.MAX_SAFE_INTEGER),
      /** Lifetime total of reservations this ledger will admit. Not metered spend. */
      budgetMicros: positive.max(Number.MAX_SAFE_INTEGER),
      maxRuntimeMs: positive.max(24 * HOUR_MS),
      maxQueuedMs: positive.max(24 * HOUR_MS),
    }),
    ledgerPath: z.string().refine(isAbsolute, 'must be absolute'),
    coreSocket: z.string().refine(isAbsolute, 'must be absolute').optional(),
    pollIntervalMs: positive.min(1000).max(300_000).default(5000),
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
