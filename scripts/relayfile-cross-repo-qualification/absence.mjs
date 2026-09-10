import { setTimeout as sleep } from 'node:timers/promises';

const NOT_FOUND = /not found|does not exist|404/i;

/** Poll Daytona until one exact ID/name is absent from info and every inventory page. */
export async function pollUntilAbsent(
  target,
  { run, timeoutMs = 60_000, initialDelayMs = 250, maxDelayMs = 5_000, now = Date.now, wait = sleep } = {}
) {
  if (typeof run !== 'function') throw new TypeError('pollUntilAbsent requires a run function');
  const deadline = now() + timeoutMs;
  let delayMs = initialDelayMs;
  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const info = await run('daytona', ['info', target, '--format', 'json'], {
      timeoutMs: Math.min(10_000, remaining),
    });
    const infoAbsent = info.exitCode !== 0 && NOT_FOUND.test(`${info.stdout}\n${info.stderr}`);
    if (infoAbsent && (await inventoryAbsent(target, run, deadline, now))) return true;
    const afterInfo = deadline - now();
    if (afterInfo <= 0) break;
    await wait(Math.min(delayMs, afterInfo));
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
  return false;
}

async function inventoryAbsent(target, run, deadline, now) {
  let cursor = '';
  for (let page = 0; page < 100; page += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) return false;
    const args = ['list', '--format', 'json', '--limit', '200'];
    if (cursor) args.push('--cursor', cursor);
    const inventory = await run('daytona', args, { timeoutMs: Math.min(10_000, remaining) });
    if (inventory.exitCode !== 0) return false;
    let parsed;
    try {
      parsed = JSON.parse(inventory.stdout);
    } catch {
      return false;
    }
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items) || items.some((entry) => entry?.id === target || entry?.name === target))
      return false;
    const next =
      parsed.nextCursor ??
      parsed.next_cursor ??
      parsed.nextPageToken ??
      parsed.next_page_token ??
      parsed.pagination?.nextCursor ??
      parsed.pagination?.next_cursor;
    if (!next) return true;
    cursor = next;
  }
  return false;
}
