# Trajectory: Create SST Lambda URL serving OpenClaw skill with invite-token behavior

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** March 4, 2026 at 01:53 PM
> **Completed:** March 4, 2026 at 01:56 PM

---

## Summary

Added SST v3 config with Cloudflare domain routing and implemented Lambda HTML endpoint serving OpenClaw SKILL content with invite_token-based workspace registration instructions.

**Approach:** Standard approach

---

## Key Decisions

### Serve SKILL.md content from a compiled string constant in Lambda

- **Chose:** Serve SKILL.md content from a compiled string constant in Lambda
- **Reasoning:** Keeps the function self-contained so deployment does not depend on reading repository files at runtime

### Use Cloudflare DNS integration for agentrelay.net in SST Router domain

- **Chose:** Use Cloudflare DNS integration for agentrelay.net in SST Router domain
- **Reasoning:** The domain is hosted on Cloudflare, so certificate and DNS record automation should target Cloudflare instead of Route53

---

## Chapters

### 1. Work

_Agent: default_

- Serve SKILL.md content from a compiled string constant in Lambda: Serve SKILL.md content from a compiled string constant in Lambda
- Use Cloudflare DNS integration for agentrelay.net in SST Router domain: Use Cloudflare DNS integration for agentrelay.net in SST Router domain
