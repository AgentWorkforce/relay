# Trajectory: Fix unattended deterministic Muse broker startup

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 20, 2026 at 02:27 PM
> **Completed:** September 20, 2026 at 05:05 PM

---

## Summary

Implemented deterministic unattended Muse startup with yolo flag deduplication, argv-delivered initial tasks, readiness-safe duplicate suppression, portable prompt validation, focused broker tests, and an exact-base/head RelayFlow proof; opened PR 1826 and addressed automated review findings.

**Approach:** Standard approach

---

## Key Decisions

### Launch broker-managed Muse with --yolo and pass the complete initial task as the final startup argv value
- **Chose:** Launch broker-managed Muse with --yolo and pass the complete initial task as the final startup argv value
- **Reasoning:** Muse otherwise renders broker initialization but does not begin the assigned work; retaining the task in broker pending state until readiness prevents follow-up delivery races while an argv-consumed marker avoids duplicate PTY injection.

### Reject non-portable Muse argv prompts before worker registration
- **Chose:** Reject non-portable Muse argv prompts before worker registration
- **Reasoning:** Muse requires its initial assignment at process startup, so argv is unavoidable. A 16 KiB UTF-8 ceiling plus NUL rejection leaves command-line headroom across supported operating systems and prevents late E2BIG/interior-NUL failures after remote identity creation.

### Keep the assigned Muse task in the positional startup argv
- **Chose:** Keep the assigned Muse task in the positional startup argv
- **Reasoning:** The live reproduction established that post-start PTY delivery leaves Muse idle, and Muse 1.3.0 exposes no prompt-file or startup-stdin interface. The assignment explicitly requires the argv startup prompt; the broker does not log the constructed command, bounds the prompt, and treats same-host process inspection as part of the worker host trust boundary.

### Canonicalized the proof broker URL from a validated loopback port
- **Chose:** Canonicalized the proof broker URL from a validated loopback port
- **Reasoning:** connection.json is on-disk state; rebuilding the origin from a checked 127.0.0.1 TCP port prevents file-controlled schemes, hosts, credentials, paths, or queries from reaching fetch and clears the CodeQL outbound-request finding

---

## Chapters

### 1. Work
*Agent: default*

- Launch broker-managed Muse with --yolo and pass the complete initial task as the final startup argv value: Launch broker-managed Muse with --yolo and pass the complete initial task as the final startup argv value
- Implementation, focused tests, and exact-base/head proof are committed; local static checks pass, while compile verification has moved to isolated PR runners because the host is under sustained swap pressure.
- Reject non-portable Muse argv prompts before worker registration: Reject non-portable Muse argv prompts before worker registration
- Keep the assigned Muse task in the positional startup argv: Keep the assigned Muse task in the positional startup argv
- Canonicalized the proof broker URL from a validated loopback port: Canonicalized the proof broker URL from a validated loopback port

---

## Artifacts

**Commits:** ec88d7995, fe98c705f, c6c646798, f91e55ea6, 7a6cc0f67, e698e37e8, bc8791108, d5236be58
**Files changed:** 11
