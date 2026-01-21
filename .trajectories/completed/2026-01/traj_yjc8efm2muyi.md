# Trajectory: Fix workspace container SSH configuration

> **Status:** ✅ Completed
> **Task:** issue-204
> **Confidence:** 90%
> **Started:** January 21, 2026 at 10:34 AM
> **Completed:** January 21, 2026 at 10:35 AM

---

## Summary

Fixed workspace container SSH setup by adding mkdir -p /etc/ssh/sshd_config.d before writing SSH config. Created Claude rule documenting that SSH is required for Codex OAuth and must never be removed.

**Approach:** Standard approach

---

## Key Decisions

### SSH in workspace containers is REQUIRED for Codex OAuth authentication
- **Chose:** SSH in workspace containers is REQUIRED for Codex OAuth authentication
- **Reasoning:** SSH tunneling enables Codex CLI to receive OAuth callbacks in cloud workspaces. The provisioner passes ENABLE_SSH=true and this must never be removed. A merge conflict accidentally brought back old SSH code that was missing mkdir -p for the config directory - fixed by adding mkdir -p /etc/ssh/sshd_config.d before writing config.

---

## Chapters

### 1. Work
*Agent: default*

- SSH in workspace containers is REQUIRED for Codex OAuth authentication: SSH in workspace containers is REQUIRED for Codex OAuth authentication
