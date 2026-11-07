# Relay CLI Product Surfaces (contract v1)

Status: active build spec. Owner: relay resident lead.

## Goal

`agent-relay` becomes the single entrypoint for every Relay product:

| CLI group              | Backing package(s)                                | Repo                                       |
| ---------------------- | ------------------------------------------------- | ------------------------------------------ |
| `agent-relay file`     | `@relayfile/sdk`                                  | `../relayfile`                             |
| `agent-relay flows`    | `@relayflows/sdk`                                 | `../flows`                                 |
| `agent-relay sessions` | `ai-hist` (sdk-ts) + `@relayhistory/cloud-client` | `../relayhistory`, `../relayhistory-cloud` |

**No command implementation may be copied into `relay`.** The relay CLI owns exactly one
generic mounter; each product repo owns its own command tree. If relay finds itself
re-implementing a product command, the fix goes in the product repo, not here.

## The contract

Every product SDK exports a **CLI surface** from a stable subpath export.
The type lives in `@agent-relay/cli-surface` (relay repo, `packages/cli-surface`,
zero runtime deps). Product repos consume it as a **devDependency** and re-declare
nothing: the surface object is structurally typed, so the published product package
carries no runtime dependency on relay.

```ts
export type RelayCliContractVersion = 1;

export interface RelayCliIo {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

export interface RelayCliArgSpec {
  name: string;
  description: string;
  required: boolean;
  variadic?: boolean;
}

export interface RelayCliOptionSpec {
  /** Commander-style flag string, e.g. '--json' or '-w, --workspace <id>'. */
  flags: string;
  description: string;
  defaultValue?: string | boolean | number;
}

export interface RelayCliCommandSpec {
  name: string;
  description: string;
  aliases?: readonly string[];
  args?: readonly RelayCliArgSpec[];
  options?: readonly RelayCliOptionSpec[];
  subcommands?: readonly RelayCliCommandSpec[];
  /** Present => host prints a deprecation notice naming this replacement. */
  deprecated?: { replacement: string; since?: string };
  /** Hidden from `--help` but still runnable. */
  hidden?: boolean;
}

export interface RelayCliSurface {
  /** Stable id: 'relayfile' | 'relayflows' | 'relayhistory'. */
  id: string;
  /** Version of the package providing the surface. */
  version: string;
  contract: RelayCliContractVersion;
  /** Full command tree. Drives help, completions, and deprecation notices. */
  commands: readonly RelayCliCommandSpec[];
  /**
   * Execute one invocation.
   * MUST resolve to a process exit code.
   * MUST NOT call process.exit(), MUST NOT write directly to process.stdout/stderr
   * (write through `io`), and MUST NOT install global signal handlers.
   */
  run(argv: readonly string[], io: RelayCliIo): Promise<number>;
}

export function createRelayCliSurface(options?: unknown): RelayCliSurface;
```

### Rules

1. `run` receives argv **after** the group name: `agent-relay flows run x.ts --json`
   calls `run(['run', 'x.ts', '--json'], io)`.
2. `commands` must describe the same tree `run` dispatches. A drift test in each repo
   asserts every spec'd command is routable and every routable command is spec'd.
3. Unknown command => exit code 2 with a message on `io.stderr`.
4. Errors thrown from `run` are caught by the host, printed via `describeError`, exit 1.
5. Surfaces are lazily imported by the host: importing `agent-relay` must not pull a
   product SDK into memory until its group is actually invoked. Cold `agent-relay --help`
   must not regress.

## Per-repo work

### `../relayfile` — export `@relayfile/sdk/relay-cli`

- The real CLI is the Go binary (`relayfile-cli`). Binary resolution currently lives in
  `packages/cli/scripts/run.js`. **Move** that resolution into the SDK
  (`packages/sdk/typescript/src/relay-cli/`), and make `packages/cli/scripts/run.js`
  call it, so binary lookup exists once.
- `commands` is generated from the Go binary's own command tree (a `relayfile
__command-spec --json` subcommand in `cmd/relayfile-cli`, checked in as a snapshot
  fixture so spec generation never requires the binary at build time).
- `run` spawns the resolved binary with inherited stdio bridged to `io`, returns its code.

### `../flows` — export `@relayflows/sdk/relay-cli`

- `packages/sdk/src/cli.ts` already exposes `runCli(argv): Promise<number>`. Wrap it:
  add `packages/sdk/src/relay-cli.ts` exporting `createRelayCliSurface()` that delegates
  to `runCli` and declares `commands`.
- `runCli` must be audited for direct `process.stdout` writes and `process.exit` calls;
  route them through the injected io.
- `packages/relayflows/bin/flows.js` keeps working unchanged (same `runCli`).

### `../relayhistory` — export `ai-hist/relay-cli`

- `sdk-ts/src/cli.ts` has a private `main()`. Extract `runCli(argv, io): Promise<number>`
  and have `main()` call it, then add `sdk-ts/src/relay-cli.ts` with the surface.
- Add the `./relay-cli` subpath export to `sdk-ts/package.json`.

### `../relayhistory-cloud` — new `@relayhistory/cloud-client`

- Today the repo is a server only; there is no client SDK to reuse.
- Add `packages/cloud-client` — a typed client over the existing routes
  (`recall`, `export`, `entries`, `turns`, `digest`, `coverage`, `sync`), generated from
  or asserted against the route handlers so it cannot drift.
- Expose the cloud-backed commands as part of the `ai-hist` surface via composition:
  `ai-hist`'s `relay-cli` accepts an optional cloud client so `agent-relay sessions`
  gets local + cloud in one tree with no third mount.

### `relay` (this repo) — mount + deprecate

- New `packages/cli-surface` (the contract types above, zero deps).
- New `packages/cli/src/cli/lib/relay-cli-surface.ts`: the **single** generic mounter
  that turns a `RelayCliSurface` into a commander subtree. Used by all three groups.
- New `packages/cli/src/cli/commands/product-surfaces.ts` registering `file`, `flows`,
  `sessions`.
- `sessions` absorbs today's `agent-relay session replay`; `session` stays as a
  **hidden alias** so existing scripts keep working.
- v1 relayflows cloud commands (`cloud run|schedule|schedules|status|logs|sync|cancel`)
  stay functional, print a stderr deprecation notice naming the `agent-relay flows`
  equivalent, and are hidden from `--help`.

## Integration & release

Publishing is chief-gated. Until green-light:

- Each repo lands its change on a feature branch.
- Relay tests against `npm pack` tarballs of the product branches (a script pins them
  under `file:` overrides) so E2E is real, not mocked.
- Version pins flip from tarball to published semver in one follow-up relay commit.

## Definition of done

- `agent-relay file --help`, `agent-relay flows --help`, `agent-relay sessions --help`
  each list the product's real command tree.
- A command from each product executes end to end through `agent-relay` against a real
  backing implementation (relayfile Go binary, relayflows runtime, ai-hist store).
- Drift tests in all four repos.
- Cold `agent-relay --help` startup time does not regress.
- Root `CHANGELOG.md` `[Unreleased - Minor]` entries for the new groups + deprecation.
