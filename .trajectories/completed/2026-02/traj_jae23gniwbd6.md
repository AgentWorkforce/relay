# Trajectory: Fix DM message injection between agents - participant parsing bug

> **Status:** ✅ Completed
> **Confidence:** 80%
> **Started:** February 25, 2026 at 10:28 AM
> **Completed:** February 25, 2026 at 10:28 AM

---

## Summary

Fixed DM message injection between agents by updating parse_dm_participants_from_conversations to handle object-format participants (agent_name, name, agent_id fields) in addition to string-format. Added 3 tests and debug logging for failed resolution.

**Approach:** Standard approach

---

## Key Decisions

### DM participant parsing was only handling string-format participants, not object-format
- **Chose:** DM participant parsing was only handling string-format participants, not object-format
- **Reasoning:** Relaycast API can return participants as objects ({agent_name, agent_id}) but parse_dm_participants_from_conversations used Value::as_str which silently drops objects. This matched the SDK's own deserialize_dm_participants which handles both formats.

### Added debug logging for empty participant resolution
- **Chose:** Added debug logging for empty participant resolution
- **Reasoning:** Silent failures are hard to debug. Added warn-level log when no participants found and debug-level log with full response body.

---

## Chapters

### 1. Work
*Agent: default*

- DM participant parsing was only handling string-format participants, not object-format: DM participant parsing was only handling string-format participants, not object-format
- Added debug logging for empty participant resolution: Added debug logging for empty participant resolution
