# Trajectory: Revise relay-pty build location decision

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** January 16, 2026 at 07:27 AM
> **Completed:** January 16, 2026 at 07:28 AM

---

## Summary

Revised decision: Multi-stage Rust build goes in Dockerfile.base (not Dockerfile) because relay-pty is infrastructure that changes rarely. CI trigger updated to detect relay-pty/ changes. 95% of builds skip Rust compilation.

**Approach:** Standard approach

---

## Key Decisions

### Put multi-stage Rust build in Dockerfile.base, not Dockerfile
- **Chose:** Put multi-stage Rust build in Dockerfile.base, not Dockerfile
- **Reasoning:** relay-pty is infrastructure code that will stabilize and change rarely (like CLI tools). Putting in main Dockerfile adds ~5 min to EVERY build even when only TypeScript changes. Better: put in Dockerfile.base + update CI to trigger base rebuild when relay-pty/ changes. 95% of builds skip Rust compilation entirely.

### Update CI trigger to detect relay-pty/ changes
- **Chose:** Update CI trigger to detect relay-pty/ changes
- **Reasoning:** Currently CI only rebuilds base on Dockerfile.base changes. Add relay-pty/ to trigger condition so base auto-rebuilds when Rust code changes. No manual intervention needed.

---

## Chapters

### 1. Work
*Agent: default*

- Put multi-stage Rust build in Dockerfile.base, not Dockerfile: Put multi-stage Rust build in Dockerfile.base, not Dockerfile
- Update CI trigger to detect relay-pty/ changes: Update CI trigger to detect relay-pty/ changes
