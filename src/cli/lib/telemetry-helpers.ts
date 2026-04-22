/**
 * Small helpers for CLI telemetry call sites.
 *
 * Kept deliberately minimal: domain events live inline at their call sites
 * (easier to read than a layer of abstraction), but a couple of utilities show
 * up often enough to centralize.
 */

import { CliExit } from './exit.js';

/**
 * Return the constructor name of an error-shaped value, for use as the
 * `error_class` telemetry property. Prefer this over `err.message` so we
 * never leak user content (file paths, run IDs, task text, URLs) into events.
 *
 * Returns `undefined` for `CliExit` — that's a sanctioned "please exit with
 * code N" signal, not an error. Callers that record `error_class` already
 * conditionally spread the property (`...(errorClass ? { error_class } : {})`),
 * so treating CliExit as undefined keeps exit-initiated propagations from
 * polluting domain events with `error_class: 'CliExit'`.
 */
export function errorClassName(err: unknown): string | undefined {
  if (err instanceof CliExit) return undefined;
  if (err instanceof Error) return err.constructor.name;
  if (err && typeof err === 'object') {
    const ctor = (err as { constructor?: { name?: string } }).constructor;
    return ctor?.name || 'Object';
  }
  return typeof err;
}
