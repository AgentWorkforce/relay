/**
 * Shared CLI exit helpers.
 *
 * Why this exists: calling `process.exit(code)` directly from a command action
 * terminates the Node process synchronously — before PostHog's in-memory
 * event buffer can flush over HTTP. That quietly loses any telemetry we
 * emitted during the command (cli_command_complete, workflow_run, etc.).
 *
 * The pattern instead: command actions throw `CliExit(code)` via the DI
 * `exit` function. `runCli()` catches it, emits the final telemetry event
 * with the real exit code, awaits `shutdownTelemetry()`, and only then
 * calls the real `process.exit(code)` — giving the flush a chance to finish.
 *
 * Tests override the DI `exit` with their own mocks (typically throwing an
 * `ExitSignal`), so this default only kicks in at production call sites.
 */

import { shutdown as shutdownTelemetry } from '@agent-relay/telemetry';

export class CliExit extends Error {
  /** Intended process exit code. */
  readonly code: number;

  constructor(code: number) {
    super(`cli-exit:${code}`);
    this.name = 'CliExit';
    this.code = code;
  }
}

/**
 * Default DI `exit` implementation for command modules. Throws {@link CliExit}
 * so the top-level `runCli()` can flush telemetry before Node exits.
 *
 * Typed as `never` to satisfy the existing `ExitFn = (code: number) => never`
 * signature — throwing counts as diverging, so this is sound.
 */
export function defaultExit(code: number): never {
  throw new CliExit(code);
}

/**
 * Wrap a signal-handler body so `CliExit` thrown by `deps.exit(code)` (i.e.
 * our shared {@link defaultExit}) is converted into a real `process.exit`
 * after flushing telemetry.
 *
 * Node doesn't await the promise returned from an async signal handler, so
 * without this wrapper the `CliExit` throw would become an unhandled
 * rejection and Node 15+ would override the intended code with 1. That's
 * what broke `Ctrl+C` exit semantics on `agent-relay up`.
 *
 * Use from any DI `onSignal` default that pairs with `defaultExit`:
 *
 * ```ts
 * onSignal: (signal, handler) => {
 *   process.on(signal, () => runSignalHandler(handler));
 * }
 * ```
 */
export function runSignalHandler(handler: () => void | Promise<void>): void {
  void Promise.resolve()
    .then(() => handler())
    .catch(async (err) => {
      if (err instanceof CliExit) {
        try {
          await shutdownTelemetry();
        } catch {
          // Best-effort — never let flush errors mask the intended exit.
        }
        process.exit(err.code);
      }
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
