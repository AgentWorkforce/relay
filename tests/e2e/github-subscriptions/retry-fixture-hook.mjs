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
    .sort((a, b) => Date.parse(b.delivered_at) - Date.parse(a.delivered_at) || b.id - a.id)[0];
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
