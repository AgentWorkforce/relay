# Trajectory: Fix cloud provisioning for GitHub cloning and agent credentials

> **Status:** ✅ Completed
> **Task:** cloud-e2e-fix
> **Confidence:** 85%
> **Started:** January 3, 2026 at 07:04 PM
> **Completed:** January 3, 2026 at 07:09 PM

---

## Summary

Fixed GitHub token to use Nango (fresh installation tokens) and added credential file creation in workspace entrypoint for Claude/Codex/Gemini

**Approach:** Standard approach

---

## Key Decisions

### Get GitHub token from Nango instead of vault
- **Chose:** Get GitHub token from Nango instead of vault
- **Reasoning:** GitHub App tokens come from Nango and expire hourly. Changed provisioner to call getGithubAppTokenForUser() which finds user's Nango connection and fetches fresh token.

### Create CLI credential files from ENV vars in workspace entrypoint
- **Chose:** Create CLI credential files from ENV vars in workspace entrypoint
- **Reasoning:** Claude CLI expects ~/.claude/credentials.json, Codex expects ~/.codex/credentials.json. Workspace entrypoint now creates these from ANTHROPIC_TOKEN, OPENAI_TOKEN, GOOGLE_TOKEN ENV vars passed by provisioner.

---

## Chapters

### 1. Work
*Agent: default*

- Get GitHub token from Nango instead of vault: Get GitHub token from Nango instead of vault
- Create CLI credential files from ENV vars in workspace entrypoint: Create CLI credential files from ENV vars in workspace entrypoint
