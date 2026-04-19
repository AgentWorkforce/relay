/**
 * Small helpers for CLI telemetry call sites.
 *
 * Kept deliberately minimal: domain events live inline at their call sites
 * (easier to read than a layer of abstraction), but a couple of utilities show
 * up often enough to centralize.
 */

/**
 * Return the constructor name of an error-shaped value, for use as the
 * `error_class` telemetry property. Prefer this over `err.message` so we
 * never leak user content (file paths, run IDs, task text, URLs) into events.
 */
export function errorClassName(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  if (err && typeof err === 'object') {
    const ctor = (err as { constructor?: { name?: string } }).constructor;
    return ctor?.name || 'Object';
  }
  return typeof err;
}
