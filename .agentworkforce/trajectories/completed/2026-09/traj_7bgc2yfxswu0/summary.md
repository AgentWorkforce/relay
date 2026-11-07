# Trajectory: Allow PTY allocation in Landlocked PR proofs

> **Status:** ✅ Completed
> **Task:** Unblock AgentWorkforce/relay#1634
> **Confidence:** 97%
> **Started:** September 2, 2026 at 03:54 AM
> **Completed:** September 2, 2026 at 04:05 AM

---

## Summary

Allowed PTY allocation under Landlock only from an initially empty devpts namespace, with positive, fail-closed, and broker-immutability Linux regressions plus updated security documentation.

**Approach:** Standard approach

---

## Key Decisions

### Grant only WRITE_FILE beneath /dev/pts
- **Chose:** Grant only WRITE_FILE beneath /dev/pts
- **Reasoning:** Linux openpty opens /dev/ptmx and then the allocated slave /dev/pts/<n>; allowing only WRITE_FILE on the existing devpts directory enables the open without granting MAKE, REMOVE, REFER, TRUNCATE, or any other mutation right.

### Fail closed when devpts already has a numeric slave
- **Chose:** Fail closed when devpts already has a numeric slave
- **Reasoning:** A directory WRITE_FILE rule would otherwise let PR-authored code write an existing agent or control PTY. The trusted launcher scans before restriction and refuses occupied namespaces; a real Daytona diagnostic confirmed the per-step executor begins empty.

---

## Chapters

### 1. Work
*Agent: default*

- Grant only WRITE_FILE beneath /dev/pts: Grant only WRITE_FILE beneath /dev/pts
- Fail closed when devpts already has a numeric slave: Fail closed when devpts already has a numeric slave
- The narrow device rule is compatible with Daytona and preserves the broker protection boundary: the empty namespace precondition passed in Cloud, and positive openpty, negative occupied-devpts, and immutability tests all passed together on Linux.
