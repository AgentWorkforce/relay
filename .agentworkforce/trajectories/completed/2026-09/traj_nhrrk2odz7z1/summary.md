# Trajectory: Close PR 1632 broker execution integrity feedback

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1632
> **Confidence:** 94%
> **Started:** September 1, 2026 at 08:53 PM
> **Completed:** September 1, 2026 at 08:56 PM

---

## Summary

Closed broker execution TOCTOU with a rehashed parent-held anonymous executable inode, made cleanup exception-safe, proved staged-path tampering cannot change the executed binary on Linux, and expanded resolver rejection coverage.

**Approach:** Standard approach

---

## Key Decisions

### Execute the verified broker through a parent-held anonymous inode
- **Chose:** Execute the verified broker through a parent-held anonymous inode
- **Reasoning:** A PR-authored runner can replace any staged checkout path after digest verification. Copy the already-verified bytes into a private mode-0500 file, rehash the copy, open it read-only, unlink it, and expose only the trusted parent process fd path while holding the handle for the runner lifetime. Replacing the staged path can no longer change the executed inode.

---

## Chapters

### 1. Work
*Agent: default*

- Execute the verified broker through a parent-held anonymous inode: Execute the verified broker through a parent-held anonymous inode
