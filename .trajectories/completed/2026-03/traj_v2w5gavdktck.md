# Trajectory: Add SST as devDependency and use local sst binary in dev:web script

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** March 4, 2026 at 02:03 PM
> **Completed:** March 4, 2026 at 02:12 PM

---

## Summary

Moved SST app into openclaw-web, updated dev:web/workflow to execute there, cleaned generated SST env artifacts, and simplified CI deploy to production-only on main merges.

**Approach:** Standard approach

---

## Key Decisions

### Isolate SST app under openclaw-web and run CLI from that directory

- **Chose:** Isolate SST app under openclaw-web and run CLI from that directory
- **Reasoning:** Prevents SST-generated helper files from appearing throughout the monorepo when developing the OpenClaw web page

### Make GitHub Action production-only on pushes to main

- **Chose:** Make GitHub Action production-only on pushes to main
- **Reasoning:** Deployment should match merge-to-main promotion and avoid stage branching logic in CI

---

## Chapters

### 1. Work

_Agent: default_

- Isolate SST app under openclaw-web and run CLI from that directory: Isolate SST app under openclaw-web and run CLI from that directory
- Make GitHub Action production-only on pushes to main: Make GitHub Action production-only on pushes to main
