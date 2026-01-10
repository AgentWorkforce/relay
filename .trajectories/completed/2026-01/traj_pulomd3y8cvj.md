# Trajectory: Refactor trajectory configuration to centralized location

> **Status:** ✅ Completed
> **Task:** lead-session-2026-01-09-centralized-config
> **Confidence:** 92%
> **Started:** January 9, 2026 at 10:23 PM
> **Completed:** January 9, 2026 at 10:24 PM

---

## Summary

Refactored trajectory configuration from repo-level to centralized ~/.config/agent-relay/relay.json. Implemented AGENT_RELAY_CONFIG_DIR env var support following existing patterns. Removed repo-level .relay/ directory. Updated lead.md documentation. All changes committed to docs/lead-agent-cli-patterns branch.

**Approach:** Standard approach

---

## Key Decisions

### Centralized config to ~/.config/agent-relay/relay.json instead of repo-level .relay/config.json
- **Chose:** Centralized config to ~/.config/agent-relay/relay.json instead of repo-level .relay/config.json
- **Reasoning:** Single config applies to all projects; survives repo deletion; follows existing AGENT_RELAY_CONFIG_DIR pattern

### Implemented AGENT_RELAY_CONFIG_DIR environment variable support
- **Chose:** Implemented AGENT_RELAY_CONFIG_DIR environment variable support
- **Reasoning:** Allows configuration location flexibility; XDG-compliant default

### Removed repo-level .relay/ directory entirely
- **Chose:** Removed repo-level .relay/ directory entirely
- **Reasoning:** No longer needed; config now centralized and not repo-specific

---

## Chapters

### 1. Initial work
*Agent: Lead*

- Centralized config to ~/.config/agent-relay/relay.json instead of repo-level .relay/config.json: Centralized config to ~/.config/agent-relay/relay.json instead of repo-level .relay/config.json
- Implemented AGENT_RELAY_CONFIG_DIR environment variable support: Implemented AGENT_RELAY_CONFIG_DIR environment variable support
- Removed repo-level .relay/ directory entirely: Removed repo-level .relay/ directory entirely
