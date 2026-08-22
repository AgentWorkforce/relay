# Trajectory: Implement node-local repo registration contract

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** August 19, 2026 at 09:03 AM
> **Completed:** August 19, 2026 at 09:26 AM

---

## Summary

Added validated node-local repoPaths configuration and path-free repo tag registration in the Fleet SDK, with compatibility, privacy serialization tests, docs, and changelog.

**Approach:** Standard approach

---

## Key Decisions

### Use repoPaths as the node-local TypeScript config and emit only derived repo:<owner/name> tags
- **Chose:** Use repoPaths as the node-local TypeScript config and emit only derived repo:<owner/name> tags
- **Reasoning:** Relaycast's current registration path already persists repo tags and Relay's installed NodeProviderClient supports tags but not repo_keys; the companion node-resolution lane owns the private broker handoff.

---

## Chapters

### 1. Work
*Agent: default*

- Use repoPaths as the node-local TypeScript config and emit only derived repo:<owner/name> tags: Use repoPaths as the node-local TypeScript config and emit only derived repo:<owner/name> tags
