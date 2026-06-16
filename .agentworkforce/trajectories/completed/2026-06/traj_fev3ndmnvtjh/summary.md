# Trajectory: Fix add_agent tool description for cross-CLI spawn routing

> **Status:** ✅ Completed
> **Task:** s08/s09 PR #1126
> **Confidence:** 93%
> **Started:** June 16, 2026 at 01:53 PM
> **Completed:** June 16, 2026 at 02:05 PM

---

## Summary

Fixed add_agent MCP tool description to map cross-CLI and model-tier spawn requests. s09-cross-cli-spawn eval (16 scenarios) proves fix: q03/q04 went 0/12→12/12 on both claude and codex harnesses. Committed, pushed to feature/s08-lead-quality-v2, PR #1126 updated.

**Approach:** Standard approach

---

## Key Decisions

### Three-version A/B eval design: baseline vs FIX v1 vs FIX v2 description
- **Chose:** Three-version A/B eval design: baseline vs FIX v1 vs FIX v2 description
- **Reasoning:** Baseline ('Ask Relaycast...') → confirms fix needed; FIX v1 (inline examples as prose) → q01 fixed 12/12 but q03/q04 still broken; FIX v2 (concrete param examples: 'spawn an opus claude agent' → cli:claude, model:claude-opus-4-8) → expected to fix q03/q04 by eliminating ambiguity in cli param mapping

### q03 (opus) zero-spawn root cause: cli param had no mapping for 'opus claude' → 'claude'
- **Chose:** q03 (opus) zero-spawn root cause: cli param had no mapping for 'opus claude' → 'claude'
- **Reasoning:** cli enum has 'claude','codex','gemini' etc. Param description only mapped 'codex agent'→codex, 'claude agent'→claude. 'opus claude agent' had no explicit mapping so model tried cli='opus' (invalid enum) or gave up. q04 (sonnet) did spawn but no model — model param description was passive 'map the request' vs directive 'required when tier is specified'. V2 fix: concrete param examples in tool description show exact cli/model combo needed.

### FIX v2 description fully fixes q03/q04 with 0→12/12 improvement
- **Chose:** FIX v2 description fully fixes q03/q04 with 0→12/12 improvement
- **Reasoning:** Key change: added concrete parameter examples directly in tool description showing 'spawn an opus claude agent' → cli:claude, model:claude-opus-4-8 and 'spawn a sonnet claude agent' → cli:claude, model:claude-sonnet-4-6. Also made cli param explicit for opus/sonnet→claude mapping, and changed model param from passive 'map the request' to directive 'Required when tier specified'. Both claude and codex harnesses show 12/12 for q03 and q04.

---

## Chapters

### 1. Work
*Agent: default*

- Three-version A/B eval design: baseline vs FIX v1 vs FIX v2 description: Three-version A/B eval design: baseline vs FIX v1 vs FIX v2 description
- q03 (opus) zero-spawn root cause: cli param had no mapping for 'opus claude' → 'claude': q03 (opus) zero-spawn root cause: cli param had no mapping for 'opus claude' → 'claude'
- FIX v2 description fully resolves cross-CLI spawn routing for all harnesses
- FIX v2 description fully fixes q03/q04 with 0→12/12 improvement: FIX v2 description fully fixes q03/q04 with 0→12/12 improvement

---

## Artifacts

**Commits:** f6f7f8edd
**Files changed:** 4
