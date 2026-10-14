import { z } from 'zod';
import {
  sessionWorkStatus,
  sessionWorkEvent,
  type SessionWorkEvent,
  type SessionWorkStatus,
} from './work.js';

const instant = z.iso.datetime({ offset: true });
export const prWorkEvidence = z.strictObject({
  url: z.url().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/),
  headSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
  state: z.enum(['open', 'closed', 'merged']),
  review: z.enum(['approved', 'changes_requested', 'pending']),
  checks: z.enum(['success', 'pending', 'failure']),
  observedAt: instant,
  mergedAt: instant.nullable(),
});
export type PrWorkEvidence = z.infer<typeof prWorkEvidence>;
export const prWorkEpisode = z
  .strictObject({
    identity: sessionWorkStatus.shape.identity,
    workEpisodeId: z.string().min(1),
    // Explicit, immutable completion requirements. Transcript/contributor links never populate this.
    required: z
      .array(z.strictObject({ dependencyId: z.string().min(1), url: prWorkEvidence.shape.url }))
      .min(1)
      .max(100),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.required.map((p) => p.dependencyId)).size !== value.required.length ||
      new Set(value.required.map((p) => p.url.toLowerCase())).size !== value.required.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate PR requirement' });
  });
export type PrWorkEpisode = z.infer<typeof prWorkEpisode>;
const canonical = (url: string) => url.toLowerCase();

/** One event at a time. The adapter supplies a durable event ID and persists the event before submission. */
export function nextPrWorkEvent(input: {
  episode: PrWorkEpisode;
  status: SessionWorkStatus;
  evidence: PrWorkEvidence[];
  now: string;
  producerId: string;
  eventId: string;
}): SessionWorkEvent | null {
  const episode = prWorkEpisode.parse(input.episode);
  const status = sessionWorkStatus.parse(input.status);
  if (
    JSON.stringify(episode.identity) !== JSON.stringify(status.identity) ||
    episode.workEpisodeId !== status.workEpisodeId ||
    !['waiting_on_pr', 'idle'].includes(status.state)
  )
    return null;
  // A late PR producer cannot interrupt working or resolve a human/agent wait.
  if (status.dependencies.some((d) => d.state === 'pending' && d.kind !== 'pr')) return null;
  const evidence = new Map(
    input.evidence.map((e) => {
      const p = prWorkEvidence.parse(e);
      return [canonical(p.url), p];
    })
  );
  const now = Date.parse(input.now);
  if (status.dependencies.filter((d) => d.kind === 'pr').length !== episode.required.length) return null;
  const required = episode.required.map((p) => ({
    ...p,
    snapshot: evidence.get(canonical(p.url)),
    dependency: status.dependencies.find(
      (d) => d.id === p.dependencyId && d.kind === 'pr' && canonical(d.target) === canonical(p.url)
    ),
  }));
  // Require a complete, fresh set, including already-resolved dependencies. No historical merge completion.
  if (
    required.some(
      (p) =>
        !p.dependency ||
        !p.snapshot ||
        now - Date.parse(p.snapshot.observedAt) > 300_000 ||
        Date.parse(p.snapshot.observedAt) > now ||
        p.snapshot.state === 'closed'
    )
  )
    return null;
  const producerId = input.producerId;
  const sequence = (status.producerSequences[producerId] ?? 0) + 1;
  const common = {
    schemaVersion: 1 as const,
    identity: episode.identity,
    workEpisodeId: episode.workEpisodeId,
    producerId,
    sequence,
    expectedRevision: status.revision,
    observedAt: input.now,
    eventId: input.eventId,
  };
  const merged = required.find(
    (p) => p.snapshot!.state === 'merged' && p.snapshot!.mergedAt && p.dependency!.state === 'pending'
  );
  if (merged)
    return sessionWorkEvent.parse({
      ...common,
      kind: 'resolve_dependency',
      dependencyId: merged.dependencyId,
    });
  if (
    required.every(
      (p) => p.snapshot!.state === 'merged' && p.snapshot!.mergedAt && p.dependency!.state === 'resolved'
    ) &&
    status.dependencies.every((d) => d.state === 'resolved')
  ) {
    return sessionWorkEvent.parse({ ...common, kind: 'complete', reason: 'merged' });
  }
  const pending = required.filter((p) => p.dependency!.state === 'pending');
  if (!pending.length || status.state !== 'waiting_on_pr') return null;
  // Check/review failure does not invent a human blocker: the runner owns that transition.
  const reason = pending.some((p) => p.snapshot!.checks !== 'success')
    ? 'pr_ci'
    : pending.some((p) => p.snapshot!.review !== 'approved')
      ? 'pr_review'
      : 'pr_merge';
  if (status.reason === reason) return null;
  return sessionWorkEvent.parse({
    ...common,
    kind: 'wait',
    reason,
    dependencies: pending.map((p) => p.dependency),
  });
}
