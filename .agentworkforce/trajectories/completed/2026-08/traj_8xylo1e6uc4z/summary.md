# Trajectory: Add privacy-safe repository registration contract

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 19, 2026 at 09:04 AM
> **Completed:** August 19, 2026 at 09:30 AM

---

## Summary

Added validated node-local repoPaths, privacy-safe registration keys/tags, TypeScript and Rust repo_keys wire plumbing, compiled-child local descriptor handoff, compatibility tests, and documentation.

**Approach:** Standard approach

---

## Key Decisions

### Used repo:<owner/repo> tags for JS provider compatibility while adding explicit repo_keys to the TypeScript/Rust broker wire mirror
- **Chose:** Used repo:<owner/repo> tags for JS provider compatibility while adding explicit repo_keys to the TypeScript/Rust broker wire mirror
- **Reasoning:** The relay repository consumes @relaycast/sdk 8.0.0, whose strict node.register shape cannot emit a new repo_keys option yet. Existing tags are already accepted and placement reads them, so deriving authoritative tags from the node-local repoPaths map keeps this PR independently landable. The Rust field remains empty until the node-resolution lane supplies keys from its validated local map.

---

## Chapters

### 1. Work
*Agent: default*

- Used repo:<owner/repo> tags for JS provider compatibility while adding explicit repo_keys to the TypeScript/Rust broker wire mirror: Used repo:<owner/repo> tags for JS provider compatibility while adding explicit repo_keys to the TypeScript/Rust broker wire mirror
- Wire contract is complete and green; security review caught that owner/repo shape must reject dot path segments, so both fleet config and compiled-child IPC now enforce exactly two allowlisted non-dot segments and absolute values.
