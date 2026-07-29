# Trajectory: Implement broker_panic telemetry hook (issue #881)

> **Status:** ✅ Completed
> **Task:** 881
> **Confidence:** 90%
> **Started:** July 15, 2026 at 07:00 PM
> **Completed:** July 21, 2026 at 07:57 AM

---

## Summary

Made Relay Reflex diagnostics quiet by default, verbose on demand, and structured-log-file aware; opened relayhistory issue #41 for native importer quiet control.

**Approach:** Standard approach

---

## Key Decisions

### broker_panic sends synchronously via a fresh OS-thread current-thread runtime
- **Chose:** broker_panic sends synchronously via a fresh OS-thread current-thread runtime
- **Reasoning:** Panic may occur on a tokio worker thread and the process may abort before the async sender loop drains; a dedicated std::thread with its own runtime avoids nested-runtime panic, and the reqwest timeout bounds process teardown

### Audit exact Commander registrations and SDK/MCP exports rather than relying on existing manifest prose
- **Chose:** Audit exact Commander registrations and SDK/MCP exports rather than relying on existing manifest prose
- **Reasoning:** The manifest already contains stale aliases and incomplete argument syntax, so repository source is the authoritative contract.

### Cloud worker teardown verifies the stored PID still belongs to the worker's foreground child
- **Chose:** Cloud worker teardown verifies the stored PID still belongs to the worker's foreground child
- **Reasoning:** The daemon is detached and persisted locally; checking worker ID plus --foreground-child before TERM/KILL prevents a stale or reused PID from targeting an unrelated process.

### Keep Reflex diagnostics quiet by default; route Relay-originated events to the shared file logger and reveal them on --verbose
- **Chose:** Keep Reflex diagnostics quiet by default; route Relay-originated events to the shared file logger and reveal them on --verbose
- **Reasoning:** The broker console is user-facing startup output, while Reflex is background maintenance. Native importer output needs an upstream quiet control because it bypasses Relay's logger.

---

## Chapters

### 1. Work
*Agent: default*

- broker_panic sends synchronously via a fresh OS-thread current-thread runtime: broker_panic sends synchronously via a fresh OS-thread current-thread runtime
- Audit exact Commander registrations and SDK/MCP exports rather than relying on existing manifest prose: Audit exact Commander registrations and SDK/MCP exports rather than relying on existing manifest prose
- Parallel audits reconciled the manifest with Commander registrations, MCP tools, SDKs, harnesses, and plugins. The catalog now uses explicit category-to-procedure mappings with contract tests so CLI and MCP drift fails locally before review.
- Cloud worker teardown verifies the stored PID still belongs to the worker's foreground child: Cloud worker teardown verifies the stored PID still belongs to the worker's foreground child
- Keep Reflex diagnostics quiet by default; route Relay-originated events to the shared file logger and reveal them on --verbose: Keep Reflex diagnostics quiet by default; route Relay-originated events to the shared file logger and reveal them on --verbose

---

## Artifacts

**Commits:** 9d90a5fc3, 3b6e4780f, 17ef166be, d837b8331, 7b68b564e, fa338f0dd, de13f5ea2, b40c3f436, a9e356da7, 86ac7875c, 229ce4724, 4d1ae3a94, 57f2796cd, a45df6c19, 969686dfc, 0b74a8d8c, 40b137c99, c8e98191b, 0db28e6bf, a01f3109f, acec6cb79, e9812c1cc, ace46dbb6, 09d2e359c, 756a0df8c, 043cfdcd2, 50bdcb3d7, b26789fbf, 66ee807e7, 7d1faa479, 69167e1be, 0cef95741, 0ea3b834f, d4f0822c2, 3be105f65, 9bb3b74d6, 8273ad7a6, e21a5310b, c4e53b4ee, ad32b0f52, e1830d851, f0c46051b, 174132123, 71d12a7bb, 09c25fc07, c9bebfdc7, 5ca0dde70, 82e62cbb5, 5bf18a1d4, 3fcb281eb, 04f02ab91, b4175f847, 740fa1f68, 08544edef, 12c851dd2, 5babccc09, 221754fa4, cd841175c, e5e641adb, a75fc78f2, 2050ad450, f9a79ee92, 50ec10f77, 60995c784, 32f072a3b, 9c5e4c2ca, d22cdfb7d, 01ffae03d, 7448b24ce, 4b0f6a69b, d4a613f44, 707cf4f42, 6b1c7b16e, 49e790e19, 586ec56eb, 5cccf7b16, 360faf31b, 7d765a829, 35e29e4ad, 9906285a4, 82fa8e356, 4764e65db, 46fdfcceb, 9dc846968, 5c583c28c, b3e8ebe38, 3f417e253, 7dc45537b, 620d44b33, debdbcff1, f2590b757, ffab28735, ad27994c3, 22ee35c51, 537780fb3, 899096f22, 121753dc1, 4aaf91d09, 183668767, 993328b69, 6a4bd74c8, 2afddc578, d1efeb5db, 059978223, 16772993b, b7cb8bc3b, 1682dcaa1, 52401a17c, fc77081bf, 908ced0c4, 4826ea2ec, 972464c55, a94d27024, 54933bc20, 98e9a513c, 5eea06c78, 8cfe9e181, 5d8746bd6, 8c65856ab, 6f0d21349, f93d946ff, 3a2e771d0, a6386f49f, 06ba42d8d, 8140e0a9e, 057121b50, c008b604b, e33e33c7f, cfb43cad9, c59d3f928, 58aea1da7, dc5776502, 766ff50d2, fc6684762, 825f5958c, cd3739577, c9f24fa71, 7a747d17c, 1653c3194, c5061036d, 53393a706, 53c889dd6, 8ba380201, 8cce01808, 3ef14433d, 98487de98, f35e2010c, 50f311ceb, 2012ac876, 8861b3e85, f8819ed71, b3760e7c5, 2c4a187d8, 642f44414, f2abd67bc, 00bbcaf46, f7db6e700, 64941e94c, e77373eac, b314e6926, 110a78a8f, b99d016af, 390627cd6, f3b967a85, 9af9de32c, 944862e7a, d59da2307, b62d384f8, 820e7cc82, 0d15ae2e4, 4683d6df9, 8841a16f3, 0e3fd9eda, 174bf7c19, c0de5f9c9, 97dcc78e1, 0bf94cab4, 7afc1ec4f, 51fd0bd38, bdd40ccba, b42d50f21, e2668f44f, 10e023eae, 5a688a97e, adae9a021, 0d7841925, 9d238e2f9, ee8a7a065, 65641b415, 0e323d0e7, ff4b2773a, 1f96aa071, fd1f4499b, 180cb8ba0, 93aad7d42, b0959ea2f, fbecb7015, 7327f215a, f1a5c92b2, d71fc621d, 29ffaff26, 21281ebce, 543d5ddf8, 89ea25c0a
**Files changed:** 249
