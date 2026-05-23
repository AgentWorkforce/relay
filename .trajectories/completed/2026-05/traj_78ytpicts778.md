# Trajectory: Address PR 932 result callback review findings

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** May 22, 2026 at 11:59 AM
> **Completed:** May 22, 2026 at 12:05 PM

---

## Summary

Verified PR 932 review findings. Fixed the valid shared-config token persistence issue by omitting AGENT*RELAY_RESULT*_ from Gemini/Droid mcp add, opencode.json, and .cursor/mcp.json while retaining inline Codex result env. Skipped the skip*relay_prompt finding because current worker spawn already sets AGENT_RELAY_RESULT*_ on the worker process even when MCP prompt injection is skipped.

**Approach:** Standard approach

---

## Key Decisions

### Do not persist result callback tokens in shared MCP config

- **Chose:** Do not persist result callback tokens in shared MCP config
- **Reasoning:** The result callback token is per spawn. Gemini/Droid mcp add, opencode.json, and .cursor/mcp.json are shared or persistent surfaces, so those paths now omit AGENT*RELAY_RESULT*\* and rely on inline configs or worker process env instead.

---

## Chapters

### 1. Work

_Agent: default_

- Do not persist result callback tokens in shared MCP config: Do not persist result callback tokens in shared MCP config
