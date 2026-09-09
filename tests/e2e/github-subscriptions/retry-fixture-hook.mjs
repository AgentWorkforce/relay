/** Node 22 preserves numeric source text in revivers; GitHub IDs exceed 2^53. */
export function parseFixtureGitHubResponse(raw) {
  if (!raw.trim()) return null;
  return JSON.parse(raw, (_key, value, context) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || Number.isSafeInteger(value)) return value;
    if (!context?.source || !/^-?\d+$/.test(context.source))
      throw new Error('Cannot preserve unsafe GitHub integer; use Node 22 or newer');
    return context.source;
  });
}

export function fixtureDeliveryId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  throw new Error('Invalid GitHub delivery ID');
}

/** Retry only a failed, owned GitHub delivery; never synthesize receiver input. */
export async function retryFailedFixtureHook({ stimulus, failure, hooks, attempts, gh, now = Date.now() }) {
  if (
    !failure ||
    failure.repo !== stimulus.repo ||
    failure.pr !== stimulus.pr ||
    failure.commentId !== stimulus.commentId
  )
    return null;
  if (!/envelope admission failed \((429|502|503|504)\)$/.test(failure.error ?? '')) return null;
  const prior = attempts.filter((a) => a.repo === stimulus.repo && a.commentId === stimulus.commentId);
  const lastAt = Math.max(Date.parse(failure.at), ...prior.map((a) => Date.parse(a.at)));
  if (!Number.isFinite(lastAt) || prior.length >= 3 || now - lastAt < 30_000) return null;
  const hook = hooks.find((h) => h.repo === stimulus.repo);
  if (!hook) return null;
  const endpoint = `repos/${hook.repo}/hooks/${hook.id}/deliveries`;
  const deliveries = await gh(`${endpoint}?per_page=100`);
  if (!Array.isArray(deliveries)) throw new Error('Invalid GitHub delivery list');
  const delivery = deliveries
    .filter((d) => d.guid === failure.deliveryId)
    .map((d) => ({ ...d, id: fixtureDeliveryId(d.id) }))
    .sort(
      (a, b) =>
        Date.parse(b.delivered_at) - Date.parse(a.delivered_at) ||
        (BigInt(b.id) > BigInt(a.id) ? 1 : BigInt(b.id) < BigInt(a.id) ? -1 : 0)
    )[0];
  if (
    !delivery ||
    !(delivery.status_code === 0 || delivery.status_code === 429 || delivery.status_code >= 500)
  )
    return null;
  const attempt = {
    at: new Date(now).toISOString(),
    repo: hook.repo,
    hookId: hook.id,
    commentId: stimulus.commentId,
    githubDeliveryId: delivery.id,
    guid: delivery.guid,
    previousStatus: delivery.status_code,
    reason: failure.error,
  };
  // Record before issuing the request so an ambiguous API failure cannot spin.
  attempts.push(attempt);
  await gh(`${endpoint}/${delivery.id}/attempts`, 'POST');
  return attempt;
}
