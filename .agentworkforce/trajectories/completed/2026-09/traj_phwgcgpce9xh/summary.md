# Trajectory: Ship agent-relay file|flows|sessions end to end, including the standalone binary

> **Status:** ✅ Completed
> **Task:** relay#1783
> **Confidence:** 90%
> **Started:** September 19, 2026 at 09:39 AM
> **Completed:** September 19, 2026 at 09:40 AM

---

## Summary

agent-relay file|flows|sessions ship in both distributions. The three product SDKs expose createRelayCliSurface behind a shared @agent-relay/cli-surface contract; the CLI mounts them from a generic mounter with spec-rendered help and verbatim argv, no product code duplicated. Reaching that took: publishing relay-cli subpaths from relayfile, flows and relayhistory; six stacked publish bugs in relayhistory that had kept its plugins off the registry at every version (bare path read as GitHub shorthand, blank NPM_TOKEN suppressing OIDC, npm 10 unable to mint an OIDC token, sixteen never-created names, a trusted publisher bound to a nonexistent workflow file, manifests lacking repository for provenance); a scope move to @relayhistory before first publish; and for the standalone binary, two rejected designs (esbuild bundling, in-process resolution from a provisioned tree) before the one that works -- run the surface in a child process under the node that installed it. Released as 12.2.6 and probe-verified against the published linux-x64 binary. Side fixes: mounted relayfile errors naming the host (relayfile#510), load-failure diagnostics distinguishing an incomplete install from a missing package, a RelayFlow proof case for the standalone mount, and relaycast#446 classifying an undecodable registration response as InvalidResponse and non-retryable, since the retry risks a duplicate registration. Open: flows#470 (v2 swarm port), flows#482 (deploy flows on change), relaycast#446 review.

**Approach:** Standard approach

---

## Key Decisions

### Record the retrospective in a new trajectory rather than the original
- **Chose:** Record the retrospective in a new trajectory rather than the original
- **Reasoning:** traj_p8fadw72db5s holds this work's 14 events but was completed by another agent sharing this checkout, with a retrospective describing their v1-to-v2 relayflow migration rather than this work. trail keeps one active trajectory per repo, so a concurrent agent's complete lands on whichever is open. A completed retrospective cannot be amended; this trajectory carries the accurate one and points at the original for the decision record.

### Run mounted surfaces in a child process when the CLI is a compiled binary
- **Chose:** Run mounted surfaces in a child process when the CLI is a compiled binary
- **Reasoning:** Two approaches failed before this one, each looking correct until a gate refused it. Bundling with esbuild (#1796) cannot work: relayfile's surface spawns a Go binary and ai-hist dlopens a native addon through a variable specifier, and all three surfaces read files relative to import.meta.url; observed in a compiled binary as ENOENT /$bunfs/root/command-spec.json. Provisioning a real tree and importing in-process got two of three groups working by accident of their dependency graphs: inside a compiled Bun binary a module loaded by absolute path cannot resolve bare specifiers from the tree beside it -- neither a bare import nor import.meta.resolve finds a scoped package with an exports subpath, and resolving the entry point by hand fixes one level while the next (yaml, imported by the flows SDK) fails identically; NODE_PATH does not help. Running the surface under the node that installed it sidesteps resolution entirely, at one process per invocation. The runner has describe and run modes because help must keep naming agent-relay rather than the product. Shipped in #1799, released as 12.2.6, probe-verified against the published linux-x64 binary.

### Gate the standalone fix on a probe that runs a compiled binary and real commands
- **Chose:** Gate the standalone fix on a probe that runs a compiled binary and real commands
- **Reasoning:** The bug is invisible to every existing check: npm installs work, so unit tests, typecheck and a normal install all pass while the compiled binary mounts nothing. scripts/standalone-mount-probe.sh runs the COMPILED binary in /tmp with an isolated HOME so no ancestor node_modules can satisfy an import, and runs a real command per group rather than --help, because help renders from a JavaScript command tree while the implementations are a Go binary and a native addon -- a help-only gate is exactly how #1796 read as correct. Validated in both directions before being relied on, which found two defects in the probe itself: declare -a GROUPS never took effect because bash keeps a special GROUPS array of the caller's group IDs (the loop iterated 1000 and 998), and the missing-implementation test matched any 'cannot find module', flagging a structured REFUSED that named the probe's own throwaway flow file. Later, CodeRabbit found an unquoted $BIN that word-split on a path with whitespace, producing a false pass. The flow built on this probe refused to declare success after the implementing agent's work looked complete with green typecheck and tests; that refusal is the only reason the in-process limit was found rather than shipped.

---

## Chapters

### 1. Work
*Agent: default*

- Record the retrospective in a new trajectory rather than the original: Record the retrospective in a new trajectory rather than the original
- Run mounted surfaces in a child process when the CLI is a compiled binary: Run mounted surfaces in a child process when the CLI is a compiled binary
- Gate the standalone fix on a probe that runs a compiled binary and real commands: Gate the standalone fix on a probe that runs a compiled binary and real commands
- The recurring failure this session was not reasoning but verification scope: every time I said 'verified' I meant a narrower thing than the word implied. relay#1783 merged and 12.2.4 published with all three groups dead, because no product SDK had published the subpath the mount imports and I had tested only local builds. I called the mount 'verified' from npm installs while the standalone distribution -- which I did not know existed -- was completely broken. I called a fix 'verified' from a two-hop Bun test that used an unscoped package, when the real case was scoped with an exports subpath and behaved differently. My probe reported 15 successful publishes as failures because it read the registry inside its own propagation window, and separately would have reported a broken binary as working on a path with whitespace. Codex reviews and reviewer bots found real defects in my work five separate times; my own self-reports, and the shepherd agent's, were wrong about completion twice each. What worked: a gate that could fail, built and validated in both directions before anything depended on it, and refusing to advance past it when it said no.
