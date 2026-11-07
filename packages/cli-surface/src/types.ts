/**
 * Contract between the `agent-relay` CLI and the Relay product CLIs it mounts
 * (`relayfile`, `relayflows`, `relayhistory`).
 *
 * A product repo implements {@link RelayCliSurface} and the host CLI mounts it
 * generically. Command implementations live in the product repo and are never
 * copied into `agent-relay`.
 *
 * The surface is structurally typed on purpose: a product package can satisfy
 * it while depending on this package only as a devDependency, so mounting adds
 * no runtime dependency on Relay to the product.
 */

/** Contract revision. Bumped only for a breaking change to these shapes. */
export type RelayCliContractVersion = 1;

/** Current contract revision. */
export const RELAY_CLI_CONTRACT_VERSION: RelayCliContractVersion = 1;

/**
 * Output sink supplied by the host. A surface writes here instead of touching
 * `process.stdout` / `process.stderr` so the host can capture, prefix, or
 * redirect product output.
 *
 * Chunks may be bytes as well as text. Some product commands stream binary to
 * stdout — `relayfile export --format tar --output -` is the motivating case —
 * and a string-only sink silently corrupts them, because the bytes round-trip
 * through UTF-8 decoding. Passing a `Uint8Array` through untouched is the only
 * way those commands survive being mounted.
 *
 * A product that only ever emits text can keep passing strings; nothing about
 * the simple case changes.
 */
export interface RelayCliIo {
  stdout(chunk: string | Uint8Array): void;
  stderr(chunk: string | Uint8Array): void;
}

/** A positional argument in a product command. */
export interface RelayCliArgSpec {
  name: string;
  description: string;
  required: boolean;
  variadic?: boolean;
}

/** A flag in a product command. */
export interface RelayCliOptionSpec {
  /** Commander-style flag string, e.g. `--json` or `-w, --workspace <id>`. */
  flags: string;
  description: string;
  defaultValue?: string | boolean | number;
}

/** Marks a command as deprecated in favour of another. */
export interface RelayCliDeprecation {
  /** The command a caller should use instead, e.g. `agent-relay flows run`. */
  replacement: string;
  /** Version the deprecation started, when known. */
  since?: string;
}

/** One node in a product command tree. */
export interface RelayCliCommandSpec {
  name: string;
  description: string;
  aliases?: readonly string[];
  args?: readonly RelayCliArgSpec[];
  options?: readonly RelayCliOptionSpec[];
  subcommands?: readonly RelayCliCommandSpec[];
  /** When present the host prints a deprecation notice naming the replacement. */
  deprecated?: RelayCliDeprecation;
  /** Runnable, but omitted from `--help`. */
  hidden?: boolean;
}

/**
 * A mountable product CLI.
 *
 * Implementations must satisfy the following, which the host relies on and the
 * conformance helpers in this package check:
 *
 * - `run` resolves to a process exit code; it never calls `process.exit`.
 * - `run` writes only through the supplied {@link RelayCliIo}.
 * - `run` installs no global signal handlers.
 * - `commands` describes the same tree `run` dispatches (see
 *   `assertSurfaceSpecMatchesRouting` in each product repo's drift test).
 * - An unknown command resolves to exit code {@link RELAY_CLI_EXIT_UNKNOWN_COMMAND}.
 */
export interface RelayCliSurface {
  /** Stable identifier, e.g. `relayfile`. */
  id: string;
  /** Version of the package providing this surface. */
  version: string;
  contract: RelayCliContractVersion;
  /** Full command tree; drives help, completions, and deprecation notices. */
  commands: readonly RelayCliCommandSpec[];
  /**
   * Execute one invocation.
   *
   * @param argv - Arguments after the mounted group name. `agent-relay flows run a.ts`
   *   arrives as `['run', 'a.ts']`.
   * @param io - Host-supplied output sink.
   * @returns The process exit code for this invocation.
   */
  run(argv: readonly string[], io: RelayCliIo): Promise<number>;
}

/** A surface module's default factory signature. */
export type RelayCliSurfaceFactory<Options = unknown> = (options?: Options) => RelayCliSurface;
