# Trajectory: Production-ready SSH tunneling for Codex OAuth with security hardening

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** January 7, 2026 at 11:08 AM
> **Completed:** January 7, 2026 at 11:09 AM

---

## Summary

Implemented production-ready SSH tunneling for Codex OAuth. Key changes: (1) Exposed SSH port 2222 publicly on Fly.io via TCP service, (2) Changed from .internal to .fly.dev hostname for public routing, (3) Created shared ssh-security.ts with deterministic password derivation (SHA-256 of workspaceId + salt), (4) Added startup validation for SSH_PASSWORD_SALT env var, (5) Created beads for future improvements: rate limiting, key-based auth, time-limited access.

**Approach:** Standard approach

---

## Key Decisions

### Changed UsageBanner intro bonus from purple to cyan
- **Chose:** Changed UsageBanner intro bonus from purple to cyan
- **Reasoning:** Brand consistency - cyan is primary accent color, purple was off-brand

### Added landing page auth check - shows Go to App when logged in
- **Chose:** Added landing page auth check - shows Go to App when logged in
- **Reasoning:** Better UX for returning users who shouldn't see Sign In buttons

### Expose SSH port 2222 publicly on Fly.io via TCP service
- **Chose:** Expose SSH port 2222 publicly on Fly.io via TCP service
- **Reasoning:** Internal .internal hostnames aren't routable from user machines. Public SSH with unique passwords per workspace is secure enough for production.

### Updated CTA terminal to show realistic CLI flow (cloud link + send)
- **Chose:** Updated CTA terminal to show realistic CLI flow (cloud link + send)
- **Reasoning:** Previous mock commands were inaccurate. Now shows actual agent-relay cloud commands

### Use deterministic password derivation instead of storage
- **Chose:** Use deterministic password derivation instead of storage
- **Reasoning:** SHA-256(workspaceId + salt) produces unique passwords without database storage. Both cloud server and container can derive the same password independently. 96 bits of entropy is sufficient.

### Create shared ssh-security.ts utility
- **Chose:** Create shared ssh-security.ts utility
- **Reasoning:** Password derivation was duplicated in provisioner and codex-auth-helper. Single source of truth prevents bugs if algorithm changes. Also adds startup validation.

### Fixed TypeScript error: Promise<never> to Promise<void>
- **Chose:** Fixed TypeScript error: Promise<never> to Promise<void>
- **Reasoning:** Promise<never> caused control flow analysis to mark subsequent code as unreachable

### Keep password-based SSH for now, defer key-based auth
- **Chose:** Keep password-based SSH for now, defer key-based auth
- **Reasoning:** Password-based is simpler to implement and per-workspace unique passwords provide reasonable security. Key-based auth would require container-side authorized_keys management - tracked as future improvement in agent-relay-476.

### Settings page: replaced sidebar with always-visible horizontal tabs
- **Chose:** Settings page: replaced sidebar with always-visible horizontal tabs
- **Reasoning:** Desktop sidebar wasn't rendering for user. Horizontal tabs provide consistent navigation on all screen sizes

### Billing API: respect database user.plan when no Stripe subscription
- **Chose:** Billing API: respect database user.plan when no Stripe subscription
- **Reasoning:** Allows manual plan overrides in database to take effect without Stripe subscription

### Billing panel: dynamic tier descriptions and smart plan recommendations
- **Chose:** Billing panel: dynamic tier descriptions and smart plan recommendations
- **Reasoning:** Fixed hardcoded Free tier text. Only highlight upgrades, not downgrades (no Pro promotion to Team users)

### Aligned workspace Codex auth with /app onboarding
- **Chose:** Aligned workspace Codex auth with /app onboarding
- **Reasoning:** Added supportsDeviceFlow prop to ProviderAuthFlow to match /app page props

---

## Chapters

### 1. Work
*Agent: default*

- Changed UsageBanner intro bonus from purple to cyan: Changed UsageBanner intro bonus from purple to cyan
- Added landing page auth check - shows Go to App when logged in: Added landing page auth check - shows Go to App when logged in
- Expose SSH port 2222 publicly on Fly.io via TCP service: Expose SSH port 2222 publicly on Fly.io via TCP service
- Updated CTA terminal to show realistic CLI flow (cloud link + send): Updated CTA terminal to show realistic CLI flow (cloud link + send)
- Use deterministic password derivation instead of storage: Use deterministic password derivation instead of storage
- Create shared ssh-security.ts utility: Create shared ssh-security.ts utility
- Fixed TypeScript error: Promise<never> to Promise<void>: Fixed TypeScript error: Promise<never> to Promise<void>
- Keep password-based SSH for now, defer key-based auth: Keep password-based SSH for now, defer key-based auth
- Settings page: replaced sidebar with always-visible horizontal tabs: Settings page: replaced sidebar with always-visible horizontal tabs
- Billing API: respect database user.plan when no Stripe subscription: Billing API: respect database user.plan when no Stripe subscription
- Billing panel: dynamic tier descriptions and smart plan recommendations: Billing panel: dynamic tier descriptions and smart plan recommendations
- Aligned workspace Codex auth with /app onboarding: Aligned workspace Codex auth with /app onboarding
