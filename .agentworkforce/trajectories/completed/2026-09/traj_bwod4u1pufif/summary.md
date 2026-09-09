# Trajectory: Restack trusted cleanroom qualification prerequisite

> **Status:** ✅ Completed
> **Task:** relay#1683
> **Confidence:** 87%
> **Started:** September 9, 2026 at 08:23 AM
> **Completed:** September 9, 2026 at 11:00 AM

---

## Summary

Hardened PR #1683 inventory path validation, candidate mount isolation, and production CLI RelayFlow coverage; resolved all 14 review threads.

**Approach:** Standard approach

---

## Key Decisions

### Restack PR 1683 onto current main before claiming qualification
- **Chose:** Restack PR 1683 onto current main before claiming qualification
- **Reasoning:** The secret-bearing verifier must inherit every current trusted-default-branch hardening change before it can unblock PRs 1665 and 1666.

### Isolated candidate inventory in a permissioned, secret-free worker and constrained candidate execution to a disposable workspace credential
- **Chose:** Isolated candidate inventory in a permissioned, secret-free worker and constrained candidate execution to a disposable workspace credential
- **Reasoning:** The trusted verifier must not import candidate bootstrap code or expose cloud/provider credentials; immutable inventory and runtime effects remain verifier-owned.

### Block inventory worker networking with a trusted preload across Node 22 and Node 24
- **Chose:** Block inventory worker networking with a trusted preload across Node 22 and Node 24
- **Reasoning:** Node 22/24 permission mode exposes no net permission API but still permits fetch; filesystem permission alone does not prove no network, so the worker must fail closed at fetch and built-in network module boundaries.

### Mount candidate installs read-only and mask verifier checkout
- **Chose:** Mount candidate installs read-only and mask verifier checkout
- **Reasoning:** Candidate code can execute during Fleet discovery; its writable surface must be limited to its disposable CWD while trusted verifier code remains inaccessible.

---

## Chapters

### 1. Work
*Agent: default*

- Restack PR 1683 onto current main before claiming qualification: Restack PR 1683 onto current main before claiming qualification
- Isolated candidate inventory in a permissioned, secret-free worker and constrained candidate execution to a disposable workspace credential: Isolated candidate inventory in a permissioned, secret-free worker and constrained candidate execution to a disposable workspace credential
- Trust blockers implemented and proportional validation is green; paid Fleet proof remains intentionally unrun.
- Block inventory worker networking with a trusted preload across Node 22 and Node 24: Block inventory worker networking with a trusted preload across Node 22 and Node 24
- Mount candidate installs read-only and mask verifier checkout

---

## Artifacts

**Commits:** 14e2eb73b, de5f65a92, 0f6cf10ad, 1c0b4b060, 3e02927d5, d1d7b2ccf, f99059929, 67f523715, 589d1ae12, b157e0708, 4306bb29b, d754fff14, dadaf8531, 5b1dc5c1d, b56e7b1f3, 69f50ba58
**Files changed:** 78
