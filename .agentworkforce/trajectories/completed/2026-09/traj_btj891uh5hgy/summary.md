# Trajectory: Repair cleanroom qualification authorization, credentialed install isolation, and fleet count drift

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 8, 2026 at 03:57 PM
> **Completed:** September 8, 2026 at 03:57 PM

---

## Summary

Hardened cleanroom qualification with a no-secret request and trusted workflow_run consumer pinned to the default workflow SHA; added authorization/artifact adversarial tests; changed credentialed installs to npm ci --ignore-scripts; derived fleet counts from matrix inventory and updated drift tests. Validation passed.

**Approach:** Standard approach

---

## Key Decisions

### Replaced the secret-bearing dispatch workflow with a no-secret request plus default-branch workflow_run consumer pinned to github.workflow_sha; derive fleet prompt counts from matrix.json.
- **Chose:** Replaced the secret-bearing dispatch workflow with a no-secret request plus default-branch workflow_run consumer pinned to github.workflow_sha; derive fleet prompt counts from matrix.json.
- **Reasoning:** A dispatch-time ref guard cannot establish a trusted code boundary when credentials are available, and hardcoded inventory counts drift as operations change.

---

## Chapters

### 1. Work
*Agent: default*

- Replaced the secret-bearing dispatch workflow with a no-secret request plus default-branch workflow_run consumer pinned to github.workflow_sha; derive fleet prompt counts from matrix.json.: Replaced the secret-bearing dispatch workflow with a no-secret request plus default-branch workflow_run consumer pinned to github.workflow_sha; derive fleet prompt counts from matrix.json.
