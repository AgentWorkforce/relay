# Trajectory: NPM package extraction cleanup - scripts and paths

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** January 22, 2026 at 03:00 PM
> **Completed:** January 22, 2026 at 03:01 PM

---

## Summary

Cleaned up npm scripts, deployment configs, and fixed stale symlinks after NPM package extraction. Updated daemon/dashboard/cloud:api scripts, railway.json, cloud-setup.sh, manual-qa.sh to use packages/*/dist paths. Fixed CLI hanging issue via setInterval.unref(). All 1768 tests pass.

**Approach:** Standard approach

---

## Key Decisions

### CLI stays in src/cli/ not packages/
- **Chose:** CLI stays in src/cli/ not packages/
- **Reasoning:** CLI is the main entry point (bin in package.json), not a reusable library. It's a consumer of packages, not a package itself.

### Package entry points: daemon/server.ts, dashboard-server/start.ts, cloud/index.ts
- **Chose:** Package entry points: daemon/server.ts, dashboard-server/start.ts, cloud/index.ts
- **Reasoning:** Each package has self-executing entry point code (checks if main module). server.ts/start.ts are standalone executables, index.ts re-exports and self-executes.

### Fixed CLI hanging with setInterval.unref() in cli-auth.ts
- **Chose:** Fixed CLI hanging with setInterval.unref() in cli-auth.ts
- **Reasoning:** Module-level setInterval kept Node event loop alive, preventing CLI from exiting. Adding .unref() allows process to exit when no other work remains.

### All packages use @agent-relay/* namespace consistently
- **Chose:** All packages use @agent-relay/* namespace consistently
- **Reasoning:** Unified naming convention for all workspace packages. npm install refreshes symlinks when package.json names match workspace package names.

### Dockerfiles copy both dist/ and packages/ directories
- **Chose:** Dockerfiles copy both dist/ and packages/ directories
- **Reasoning:** Packages compile to packages/*/dist/, root compiles to dist/. Both needed at runtime. Cloud entry point changed to packages/cloud/dist/index.js.

---

## Chapters

### 1. Work
*Agent: default*

- CLI stays in src/cli/ not packages/: CLI stays in src/cli/ not packages/
- Package entry points: daemon/server.ts, dashboard-server/start.ts, cloud/index.ts: Package entry points: daemon/server.ts, dashboard-server/start.ts, cloud/index.ts
- Fixed CLI hanging with setInterval.unref() in cli-auth.ts: Fixed CLI hanging with setInterval.unref() in cli-auth.ts
- All packages use @agent-relay/* namespace consistently: All packages use @agent-relay/* namespace consistently
- Dockerfiles copy both dist/ and packages/ directories: Dockerfiles copy both dist/ and packages/ directories
