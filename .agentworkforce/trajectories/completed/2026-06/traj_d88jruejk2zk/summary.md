# Trajectory: Fix @agent-relay/fleet exports dropped to undefined in bun --compile standalone binary (local up Fleet local node skipped)

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 22, 2026 at 09:44 AM
> **Completed:** June 22, 2026 at 10:06 AM

---

## Summary

Fixed bun-compiled CLI dropping @agent-relay/_ workspace exports to undefined (Fleet local node skipped / 'is not a function' on local up). Root cause: bun & esbuild honor tsconfig paths that map workspace packages to their .d.ts (no runtime exports); paths resolve per nearest tsconfig to the importing file, so transitive imports broke too. Final fix (after a fresh-eyes review pivoted away from an earlier build-script workaround): removed the redundant @agent-relay/_ paths from the root and packages/cli tsconfig.json — they duplicated the npm workspace node_modules symlinks, so tsc still resolves .d.ts (via package exports.types) and bundlers resolve .js (via exports.import). Also reverted the now-obsolete namespace-import workarounds in fleet-sidecar.ts and fleet/src/index.ts to plain named imports. tsc type-checking untouched. Verified: build:core green (0 type errors), built binary, local up starts implicit fleet node with fleet-node.json connected:true + spawn:claude/codex/gemini.

**Approach:** Standard approach

---

## Key Decisions

### Fix at the bundler layer via empty-paths tsconfig next to the build entry

- **Chose:** Fix at the bundler layer via empty-paths tsconfig next to the build entry
- **Reasoning:** Root cause: packages/cli/tsconfig.json paths map @agent-relay/\* to dist/index.d.ts; bun/esbuild honor tsconfig paths and bundle the declaration files (no runtime exports) -> undefined. fleet breaks because it is only ever namespace-imported. Build-script override is surgical and leaves tsc type-checking untouched, vs changing shared root paths.

---

## Chapters

### 1. Work

_Agent: default_

- Fix at the bundler layer via empty-paths tsconfig next to the build entry: Fix at the bundler layer via empty-paths tsconfig next to the build entry
- Root cause is bun/esbuild honoring tsconfig paths (->.d.ts, no runtime exports) per-importing-file; fix needs empty-paths tsconfig in EVERY bundled package dist, not just the entry, to cover transitive workspace imports. Verified end-to-end: fleet-node.json connected:true with all spawn handlers.
