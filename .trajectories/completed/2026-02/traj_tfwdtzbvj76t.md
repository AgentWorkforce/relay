# Trajectory: Fix codex TOML config parsing: RELAY_STRICT_AGENT_NAME must be quoted string

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 24, 2026 at 10:53 PM
> **Completed:** February 24, 2026 at 10:54 PM

---

## Summary

Fixed codex spawning crash caused by RELAY_STRICT_AGENT_NAME=1 being parsed as TOML integer instead of string. Changed to quoted "1" in snippets.rs codex config args and updated 2 matching tests. Added inline comment explaining the quoting is intentional.

**Approach:** Standard approach

---

## Key Decisions

### Quote RELAY_STRICT_AGENT_NAME value as string in codex TOML config

- **Chose:** Quote RELAY_STRICT_AGENT_NAME value as string in codex TOML config
- **Reasoning:** Codex --config flag parses TOML. Bare 1 is parsed as integer, but env vars expect strings. Wrapping in quotes ("1") forces TOML to treat it as a string. Added inline comment explaining this is intentional.

---

## Chapters

### 1. Work

_Agent: default_

- Quote RELAY_STRICT_AGENT_NAME value as string in codex TOML config: Quote RELAY_STRICT_AGENT_NAME value as string in codex TOML config
