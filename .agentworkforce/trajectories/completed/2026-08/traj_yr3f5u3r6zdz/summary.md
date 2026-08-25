# Trajectory: Add PR-specific Cloud RelayFlow red-green proof infrastructure

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** August 25, 2026 at 10:45 AM
> **Completed:** August 25, 2026 at 11:14 AM

---

## Summary

Implemented trusted PR classification and single-case dispatch, a fail-closed Cloud RelayFlow that proves base then head in distinct per-step sandboxes, provenance/evidence validation, GitHub Action wiring, tests, template guidance, and credential rollout documentation.

**Approach:** Kept pull_request_target as a data-only trusted dispatcher, ran PR code only in Cloud, represented expected-red as a structured successful observation, disabled repair retries, validated exact base/head SHAs and sandbox IDs, and tested both the contracts and the complete repository.

---

## Key Decisions

### Require exactly one PR proof case and a structured observation result
- **Chose:** Require exactly one PR proof case and a structured observation result
- **Reasoning:** One feature or fix should trigger only its own case. The case runner must exit successfully after observing behavior and write bug/absent/fixed plus an exact signature; test crashes, missing tests, skips, and build failures remain infrastructure failures and cannot count as expected red.

### Use pull_request_target only as a trusted dispatcher; execute PR case code only inside Cloud sandboxes
- **Chose:** Use pull_request_target only as a trusted dispatcher; execute PR case code only inside Cloud sandboxes
- **Reasoning:** The GitHub runner must never checkout or execute untrusted head code while holding Cloud credentials. It will fetch and validate one declarative case manifest, stage exact base/head SHAs, and submit the trusted base-branch RelayFlow.

### Disable automatic repair and retries for PR proof workflows
- **Chose:** Disable automatic repair and retries for PR proof workflows
- **Rejected:** Default retry policy, Continue on failure
- **Reasoning:** A red/green gate must preserve the first observation and fail closed. RelayFlow defaults to agent-assisted repair retries when agents exist, so the proof workflow explicitly uses fail-fast with zero step retries.

### Stage the validated generated input in the disposable CI git index
- **Chose:** Stage the validated generated input in the disposable CI git index
- **Rejected:** Change global code-sync semantics, Commit a placeholder input file
- **Reasoning:** Cloud code sync uploads git-known files. The per-PR input is generated after checkout, so the action must git-add it without committing or pushing or the Cloud workflow cannot see the exact case and SHAs.

### Require explicit proof classification on every PR
- **Chose:** Require explicit proof classification on every PR
- **Rejected:** Infer only from conventional titles, Run Cloud for every PR
- **Reasoning:** Silently treating missing metadata as non-functional would let non-conventional feature and fix titles bypass the gate. Every PR must declare feature, bugfix, or non-functional; only the first two launch Cloud.

---

## Chapters

### 1. Work
*Agent: default*

- Require exactly one PR proof case and a structured observation result: Require exactly one PR proof case and a structured observation result
- Use pull_request_target only as a trusted dispatcher; execute PR case code only inside Cloud sandboxes: Use pull_request_target only as a trusted dispatcher; execute PR case code only inside Cloud sandboxes
- Disable automatic repair and retries for PR proof workflows: Disable automatic repair and retries for PR proof workflows
- Stage the validated generated input in the disposable CI git index: Stage the validated generated input in the disposable CI git index
- Require explicit proof classification on every PR: Require explicit proof classification on every PR
