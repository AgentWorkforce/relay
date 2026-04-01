# Trajectory: Provider CLI auth flow for cloud workspaces

> **Status:** ✅ Completed
> **Task:** pre-launch-fixes
> **Confidence:** 70%
> **Started:** January 4, 2026 at 01:05 AM
> **Completed:** January 5, 2026 at 10:10 PM

---

## Summary

Previous session work on provider CLI auth flow

**Approach:** Standard approach

---

## Key Decisions

### Pre-seed Claude CLI config to skip interactive setup
- **Chose:** Pre-seed Claude CLI config to skip interactive setup
- **Reasoning:** Claude CLI has interactive first-run (theme selection, etc). Alternative was web terminal (xterm.js) which is more flexible but complex. Pre-seeding config is simpler for MVP. May revisit for web terminal if other CLIs have similar issues.

### Add settings page for CLI provider management
- **Chose:** Add settings page for CLI provider management
- **Reasoning:** Users should be able to connect additional AI providers after initial setup. Settings page in workspace dashboard will allow connecting Claude, Codex, OpenCode, Droid at any time, not just during initial workspace setup.

### Default trajectories to opt-out (user-level storage)
- **Chose:** Default trajectories to opt-out (user-level storage)
- **Reasoning:** Most repos won't want trajectory files in source control. Users must explicitly opt-in to store in repo via .relay/config.json

### Store user-level trajectories in ~/.config/agent-relay/trajectories/<project-hash>/
- **Chose:** Store user-level trajectories in ~/.config/agent-relay/trajectories/<project-hash>/
- **Reasoning:** XDG-compliant path, project-isolated via hash to prevent collisions, survives repo deletion

### Trajectory settings configurable after GitHub app setup
- **Chose:** Trajectory settings configurable after GitHub app setup
- **Reasoning:** Users should configure .relay/config.json after connecting repo to cloud workspace. This happens in the workspace onboarding flow.

### Add dashboard API for trajectory preferences
- **Chose:** Add dashboard API for trajectory preferences
- **Reasoning:** Users configure via dashboard after GitHub app setup, during workspace onboarding

### Add comprehensive settings with trajectory explanations
- **Chose:** Add comprehensive settings with trajectory explanations
- **Reasoning:** Users need to understand what trajectories are (PDERO paradigm), why they'd opt-in, and link to pdero.com for more info

### Investigate Claude OAuth login flow
- **Chose:** Investigate Claude OAuth login flow
- **Reasoning:** Current provider setup uses API keys but Claude uses OAuth. Need to bypass interactive prompts and get login URL for popup-based auth.

### Cloud provider auth strategy for Claude
- **Chose:** Cloud provider auth strategy for Claude
- **Reasoning:** Claude uses OAuth in cloud environments. For users connecting accounts: 1) API key works (already supported), 2) CLI setup-token is interactive, 3) Need proper OAuth device flow from Anthropic. Recommend API key for now with improved UX.

### Use node-pty for CLI OAuth flow
- **Chose:** Use node-pty for CLI OAuth flow
- **Reasoning:** Regular spawn with pipes doesn't properly emulate TTY, causing CLIs to behave differently. PTY ensures auth URLs are output correctly and allows sending responses to interactive prompts.

### Auto-respond to Claude interactive setup prompts
- **Chose:** Auto-respond to Claude interactive setup prompts
- **Reasoning:** Claude has multi-step setup: dark mode -> auth method -> login URL. We detect prompts and send enter key to progress through them automatically.

### Fixed cloud server body limit for screenshot uploads
- **Chose:** Fixed cloud server body limit for screenshot uploads
- **Reasoning:** Default express.json limit of 100kb was too small for base64 encoded images

### Added GH_TOKEN env var for gh CLI compatibility
- **Chose:** Added GH_TOKEN env var for gh CLI compatibility
- **Reasoning:** gh CLI uses GH_TOKEN not GITHUB_TOKEN; added to all provisioners (Fly.io, Railway, Docker)

### Fixed mobile usability issues in dashboard
- **Chose:** Fixed mobile usability issues in dashboard
- **Reasoning:** Hamburger menu visibility, logs button always visible on mobile, responsive padding throughout

---

## Chapters

### 1. Work
*Agent: default*

- Pre-seed Claude CLI config to skip interactive setup: Pre-seed Claude CLI config to skip interactive setup
- Add settings page for CLI provider management: Add settings page for CLI provider management
- Default trajectories to opt-out (user-level storage): Default trajectories to opt-out (user-level storage)
- Store user-level trajectories in ~/.config/agent-relay/trajectories/<project-hash>/: Store user-level trajectories in ~/.config/agent-relay/trajectories/<project-hash>/
- Trajectory settings configurable after GitHub app setup: Trajectory settings configurable after GitHub app setup
- Add dashboard API for trajectory preferences: Add dashboard API for trajectory preferences
- Add comprehensive settings with trajectory explanations: Add comprehensive settings with trajectory explanations
- Investigate Claude OAuth login flow: Investigate Claude OAuth login flow
- Cloud provider auth strategy for Claude: Cloud provider auth strategy for Claude
- Use node-pty for CLI OAuth flow: Use node-pty for CLI OAuth flow
- Auto-respond to Claude interactive setup prompts: Auto-respond to Claude interactive setup prompts
- Fixed cloud server body limit for screenshot uploads: Fixed cloud server body limit for screenshot uploads
- Added GH_TOKEN env var for gh CLI compatibility: Added GH_TOKEN env var for gh CLI compatibility
- Fixed mobile usability issues in dashboard: Fixed mobile usability issues in dashboard
