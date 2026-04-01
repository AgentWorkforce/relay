# Trajectory: Comprehensive relay-pty binary resolution edge case handling

> **Status:** ✅ Completed
> **Task:** PR-344
> **Confidence:** 90%
> **Started:** January 29, 2026 at 10:50 AM
> **Completed:** January 29, 2026 at 10:51 AM

---

## Summary

Added comprehensive relay-pty binary resolution supporting npx, all Node version managers (nvm/volta/fnm/n/asdf), pnpm, yarn, Homebrew, and system-wide installs. Platform-specific binaries checked first to fix npx postinstall issue. Added executable permission checking and utility exports for better error messages. 155 tests passing with CI coverage.

**Approach:** Standard approach

---

## Key Decisions

### Check platform-specific binaries FIRST in search order
- **Chose:** Check platform-specific binaries FIRST in search order
- **Reasoning:** npx doesn't run postinstall scripts for security reasons, so the generic relay-pty symlink never gets created. Platform-specific binaries (e.g., relay-pty-darwin-arm64) exist in the tarball and work without postinstall.

### Use isExecutable() with X_OK permission check instead of existsSync()
- **Chose:** Use isExecutable() with X_OK permission check instead of existsSync()
- **Reasoning:** A file might exist but not be executable (wrong permissions, not a binary). Checking X_OK ensures the binary can actually be executed, preventing confusing runtime errors.

### Support ALL major Node version managers (nvm, volta, fnm, n, asdf)
- **Chose:** Support ALL major Node version managers (nvm, volta, fnm, n, asdf)
- **Reasoning:** Different developers use different version managers. Missing any one creates a poor DX where 'it just works' fails for a subset of users. Each has unique path conventions that must be handled.

### Export isPlatformSupported() and getSupportedPlatforms() utilities
- **Chose:** Export isPlatformSupported() and getSupportedPlatforms() utilities
- **Reasoning:** When binary resolution fails, error messages should tell users exactly which platforms are supported. These utilities enable helpful error messages like 'relay-pty is not available for win32-x64. Supported: darwin-arm64, darwin-x64, linux-arm64, linux-x64'.

### Test search paths rather than mock file system
- **Chose:** Test search paths rather than mock file system
- **Reasoning:** Mocking fs in ESM is complex and brittle. Instead, tests verify the search paths array is correct for each scenario. This catches path construction bugs without fighting ESM module semantics.

---

## Chapters

### 1. Work
*Agent: default*

- Check platform-specific binaries FIRST in search order: Check platform-specific binaries FIRST in search order
- Use isExecutable() with X_OK permission check instead of existsSync(): Use isExecutable() with X_OK permission check instead of existsSync()
- Support ALL major Node version managers (nvm, volta, fnm, n, asdf): Support ALL major Node version managers (nvm, volta, fnm, n, asdf)
- Export isPlatformSupported() and getSupportedPlatforms() utilities: Export isPlatformSupported() and getSupportedPlatforms() utilities
- Test search paths rather than mock file system: Test search paths rather than mock file system
