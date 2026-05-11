# Trajectory: Fix publish smoke cloud tarball dependency

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** May 11, 2026 at 09:49 AM
> **Completed:** May 11, 2026 at 09:50 AM

---

## Summary

Updated publish.yml smoke packaging to pack packages/cloud, locate agent-relay-cloud-_.tgz, and include it in the scratch npm install. Verified YAML parses and added a static Node check that the smoke workflow covers all @agent-relay/_ SDK dependencies.

**Approach:** Standard approach

---

## Key Decisions

### Added cloud to publish smoke local tarballs

- **Chose:** Added cloud to publish smoke local tarballs
- **Reasoning:** @agent-relay/cloud is an exact-version SDK dependency after release version bump, so the pre-publish scratch install must use the locally packed cloud tarball just like config/github/slack/workflow-types.

---

## Chapters

### 1. Work

_Agent: default_

- Added cloud to publish smoke local tarballs: Added cloud to publish smoke local tarballs
