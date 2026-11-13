# RFC: Lightweight shared CLI resolver

## Summary

This RFC proposes adding a lightweight shared CLI resolver module for Agent Relay so other packages can reuse CLI path-resolution logic without depending on the full `@agent-relay/sdk` surface.

Suggested home:
- `@agent-relay/utils/cli-resolver`

Possible optional re-export later:
- `@agent-relay/sdk/cli-resolver`

The main goal is to make CLI resolution reusable, dependency-light, and stable for small packages, installers, wrappers, and other tooling that only need to locate binaries like `claude`, `codex`, or `gemini`.

## Motivation

Today, consumers that want a tiny piece of functionality like CLI path resolution can end up needing to pull in a much heavier dependency surface than they actually need.

That is a bad trade when the desired behavior is small and self-contained:

- resolve a CLI from `PATH`
- try a few known fallback directories
- report useful diagnostics when nothing is found

For the immediate PR that prompted this RFC, the logic was inlined instead of importing the full SDK. That was the right local decision. But the fact that this came up at all suggests there is a missing lightweight shared module.

## Problem statement

CLI resolution logic is broadly useful but does not belong behind a heavyweight dependency boundary.

Pulling in the full SDK just to resolve CLI executables is undesirable because:

- it increases install size and dependency weight
- it can drag in unrelated runtime concerns
- it complicates reuse in tiny helper packages
- it makes bundling and startup behavior harder to reason about

At the same time, duplicating CLI resolution logic across packages risks drift in:

- fallback order
- supported CLI names
- home-directory expansion
- diagnostics and error messages
- platform behavior

## Goals

- Provide a single reusable implementation for CLI resolution
- Keep it lightweight and dependency-minimal
- Support small packages without requiring the full SDK
- Keep behavior consistent across repos/packages
- Make diagnostics good enough for CLI UX and debugging
- Keep the module testable in isolation

## Non-goals

- Spawning processes
- PTY management
- agent runtime configuration
- model selection
- auth setup
- broker integration
- installer flows beyond path resolution

This RFC is only about locating CLI binaries and exposing definitions for known CLIs.

## Proposal

Add a lightweight utility module in:

- `packages/utils/src/cli-resolver.ts`

and export it as:

- `@agent-relay/utils/cli-resolver`

Optionally, after adoption, re-export it from:

- `@agent-relay/sdk/cli-resolver`

but the implementation itself should live in a lightweight package.

## API sketch

```ts
export type KnownCliName =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'qwen'
  | 'pi';

export interface CliCandidate {
  path: string;
  source:
    | 'PATH'
    | 'LOCAL_BIN'
    | 'CLAUDE_LOCAL'
    | 'USR_LOCAL_BIN'
    | 'HOMEBREW_BIN'
    | 'CUSTOM';
  exists?: boolean;
}

export interface CliDefinition {
  name: KnownCliName;
  binaryNames: string[];
  fallbackPaths: string[];
}

export interface ResolveCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  extraPaths?: string[];
  allowMissing?: boolean;
}

export interface ResolveCliResult {
  name: KnownCliName;
  resolvedPath?: string;
  candidates: CliCandidate[];
  found: boolean;
}

export function getCliDefinition(name: KnownCliName): CliDefinition;

export function listCliCandidates(
  name: KnownCliName,
  options?: ResolveCliOptions
): CliCandidate[];

export function resolveCli(
  name: KnownCliName,
  options?: ResolveCliOptions
): ResolveCliResult;

export function resolveCliOrThrow(
  name: KnownCliName,
  options?: ResolveCliOptions
): string;
```

## Behavior

### 1. Data-first definitions

Known CLIs should be described with small, explicit definitions.

Example:

```ts
const CLI_DEFINITIONS = {
  claude: {
    name: 'claude',
    binaryNames: ['claude'],
    fallbackPaths: [
      '~/.local/bin/claude',
      '~/.claude/local/claude',
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ],
  },
};
```

This keeps the resolver predictable and easy to update.

### 2. PATH resolution first

The resolver should first search the current `PATH`, using built-in Node behavior rather than depending on external binaries or new packages.

Preferred approach:
- manually scan `PATH`
- join candidate directories with known binary names
- check whether the candidate exists and is executable

This avoids:
- subprocess overhead
- shell-specific behavior
- additional dependencies

### 3. Fallback directories second

If no PATH candidate is found, try known fallback locations in a stable order.

For example:
- `~/.local/bin`
- `~/.claude/local`
- `/usr/local/bin`
- `/opt/homebrew/bin`

That order should be shared across consumers instead of being reimplemented ad hoc.

### 4. Diagnostics as a first-class feature

The module should expose all candidates checked, not just the final winner.

This makes it easy to build:
- good CLI error messages
- `doctor` output
- install hints
- debug logging

## Suggested helper behavior

### `getCliDefinition(name)`
Returns the canonical definition for the named CLI.

### `listCliCandidates(name, options)`
Returns the ordered list of candidate paths and their source category.

### `resolveCli(name, options)`
Returns:
- whether a CLI was found
- the resolved path, if any
- the full candidate list for diagnostics

### `resolveCliOrThrow(name, options)`
Convenience wrapper that throws a useful human-readable error when resolution fails.

Example message:

```txt
Could not resolve CLI "claude".
Checked:
- claude on PATH
- ~/.local/bin/claude
- ~/.claude/local/claude
- /usr/local/bin/claude
- /opt/homebrew/bin/claude
```

## Why `utils` instead of `sdk`

`utils` is the better implementation home because the resolver is:

- generic
- synchronous/simple
- dependency-light
- not semantically tied to relay transport/runtime behavior

Placing this in `utils` makes the dependency intent clearer:

- small helper packages can depend on it safely
- the full SDK stays focused on higher-level runtime behavior
- optional re-exports remain possible later

## Why not keep it inlined everywhere

Inlining is okay as a short-term choice for one PR when extraction would be premature.

But long-term, duplication creates unnecessary drift risk in:
- fallback order
- supported CLI list
- diagnostics
- edge-case handling

A shared utility is a better long-term boundary.

## Implementation guidance

### Keep it tiny

This module should only use:
- Node built-ins
- existing lightweight package-local helpers if needed

Avoid any dependency on:
- broker code
- PTY code
- websocket code
- heavy SDK initialization paths

### Keep it synchronous by default

CLI resolution is usually part of startup/dispatch and is easiest to consume synchronously.

Unless there is a strong reason otherwise, prefer a sync implementation.

### Expand `~` explicitly

Fallbacks like `~/.local/bin/claude` should be expanded using `HOME` / `USERPROFILE`.

### Deduplicate candidates

If the same candidate appears from multiple sources, normalize and deduplicate before checking/exposing them.

### Keep source labels stable

Source labels like `PATH`, `LOCAL_BIN`, `CLAUDE_LOCAL`, `USR_LOCAL_BIN`, and `HOMEBREW_BIN` make diagnostics much clearer and should be stable enough for testing.

## Testing plan

Add focused unit tests for:

1. resolves from `PATH`
2. falls back to `~/.local/bin`
3. falls back to `~/.claude/local`
4. falls back to `/usr/local/bin`
5. falls back to `/opt/homebrew/bin`
6. preserves candidate order
7. deduplicates repeated candidates
8. expands `~` correctly
9. respects custom/extra paths
10. returns useful diagnostics when missing

## Rollout plan

### Phase 1
- add `@agent-relay/utils/cli-resolver`
- add tests
- document usage

### Phase 2
- migrate duplicated inlined resolvers in nearby packages where it clearly reduces drift

### Phase 3
- optionally add a thin re-export from `@agent-relay/sdk/cli-resolver` if that improves ergonomics for SDK consumers

## Alternatives considered

### 1. Keep the logic inlined

Pros:
- simplest for the immediate package
- no extra extraction work

Cons:
- duplicated logic drifts over time
- no shared diagnostics shape
- repeated maintenance burden

### 2. Export from the full SDK only

Pros:
- single existing package namespace

Cons:
- still too heavy for lightweight consumers
- encourages accidental coupling to unrelated runtime concerns

### 3. Create a standalone new package

Pros:
- extremely clear boundary

Cons:
- more package overhead than likely needed right now
- probably unnecessary if `utils` already serves this role well

## Recommendation

Adopt a small shared CLI resolver in `@agent-relay/utils/cli-resolver`.

That gives Agent Relay:
- a reusable implementation
- a lightweight dependency boundary
- consistent CLI lookup behavior
- better diagnostics
- easier future reuse across packages

For the original PR that triggered this idea, inlining was still a good tactical decision. This RFC is about the next step: extracting the shared logic once it is clearly useful in more than one place.
