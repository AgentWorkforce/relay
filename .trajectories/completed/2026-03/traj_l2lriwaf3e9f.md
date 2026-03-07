# Trajectory: Switch OpenClaw Lambda to import SKILL.md instead of embedding copied content

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** March 4, 2026 at 01:58 PM
> **Completed:** March 4, 2026 at 01:59 PM

---

## Summary

Replaced embedded markdown blob with direct import from packages/openclaw/skill/SKILL.md; configured SST Function .md text loader and added TypeScript module declaration.

**Approach:** Standard approach

---

## Key Decisions

### Use SST/esbuild .md text loader instead of adding a markdown-import package

- **Chose:** Use SST/esbuild .md text loader instead of adding a markdown-import package
- **Reasoning:** Keeps dependencies minimal and bundles markdown content directly at build time

---

## Chapters

### 1. Work

_Agent: default_

- Use SST/esbuild .md text loader instead of adding a markdown-import package: Use SST/esbuild .md text loader instead of adding a markdown-import package
