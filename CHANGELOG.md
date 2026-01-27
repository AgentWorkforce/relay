# Changelog

All notable changes to Agent Relay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.20] - 2026-01-26

### Overview
- Major SDK expansion with swarm primitives, logs API, and protocol types.
- New CLI auth testing package with Dockerized workflows and scripts.
- Relay-pty and wrapper improvements focused on reliability and orchestration.
- Expanded documentation for swarm primitives and testing guides.

### Product Perspective
#### User-Facing Features & Improvements
- Swarm primitives added to SDK with full documentation and examples.
- CLI auth testing tooling introduced with repeatable scripts and Docker workflows.
- Provider connection UI copy refreshed (OpenCode/Droid messaging updates).
- Improved onboarding reliability for OAuth flows in cloud workspaces.

#### User-Impacting Fixes
- Spawner registration timeouts in cloud workspaces resolved.
- Idle detection behavior made more robust to avoid false positives.
- OAuth URL parsing now handles line-wrapped output from CLI.

#### Deprecations
- None noted for this release.

#### Breaking Changes & Migration Guidance
- None noted for this release.

### Technical Perspective
#### Architecture & API Changes
- New SDK client capabilities (`client`, `logs`, and protocol types) and expanded test coverage.
- Spawner logic updated for more reliable agent registration and routing.
- Relay-pty orchestration updated in Rust core with supporting wrapper changes.

#### Performance & Reliability
- Idle detection strengthened in wrapper layer (logic + tests).
- Relay-pty orchestration hardened; additional tests for injection handling.

#### Dependencies & Tooling
- Workspace package updates and lockfile refresh.
- New hooks scripts (`scripts/hooks/install.sh`, `scripts/hooks/pre-commit`) for developer workflows.
- Dockerfiles updated for workspace and CLI testing images.

#### Implementation Details (For Developers)
- Added `packages/cli-tester` with auth credential checks and socket client utilities.
- New CLI tester scripts for spawn/registration/auth flows.
- `packages/config` gains CLI auth config updates for cloud onboarding.
- `relay-pty` binary updated for macOS arm64.

### Added
- `@agent-relay/mcp` package with MCP tools/resources and one-command install.
- Swarm primitives SDK API and examples (`SWARM_CAPABILITIES`, `SWARM_PATTERNS`).
- CLI auth testing package with Docker and scripted flows.
- New roadmap/spec documentation for primitives and multi-server architecture.

### Fixed
- Cloud spawner timeout in agent registration.
- OAuth URL parsing for line-wrapped output in CLI auth flows.
- Idle detection stability in wrapper layer.
- Relay-pty postinstall and codesign handling for macOS builds.
- Minor CI/test issues in relay-pty orchestrator tests.

### Changed
- Dynamic import for MCP commands in CLI.
- Spawner and daemon routing adjustments for improved registration and diagnostics.
- Wrapper base class behavior and tests for relay-pty orchestration.

### Infrastructure & Refactors
- Updates to workspace Dockerfiles and publish workflow tweaks.
- Package metadata alignment across SDK, dashboard, wrapper, spawner, and api-types.
- Additional instrumentation in relay-pty and orchestrator to support reliability.

### Documentation
- Swarm primitives guide and comprehensive roadmap specification.
- CLI auth testing guide.

### Recent Daily Breakdown
#### 2026-01-27
- Merged swarm primitives and channels work into mainline (#314).
- Relay and orchestrator fixes: relay-pty updates, wrapper base changes, and new dev hooks.

#### 2026-01-26
- Added CLI auth testing package with Docker workflow and scripts.
- Added swarm primitives SDK APIs, examples, and documentation.
- Added primitives roadmap spec and beads/trajectory artifacts.
- Fixed spawner registration timeout in cloud workspaces.
- Improved onboarding behavior for OAuth URL wrapping and bypass permissions.
- Hardened idle detection and relay-pty orchestration; added tests.
- Updated package-lock and workspace package metadata; release tags v2.0.18–v2.0.20.

### Commit Activity (Past 3 Weeks)
- 23 commits across Jan 26–27, 2026 (21 on Jan 26; 2 on Jan 27).
- Authors: Khaliq (18), GitHub Actions (3), Agent Relay (2).
- Top scopes: `feat`, `fix`, `docs`, `chore`.

---

## [Three-Week Retrospective: Jan 3–24, 2026]

## [Week 1: January 3-10, 2026]

### Product Perspective
**Core Messaging & Communication**
- First-class channels and direct messages as core features.
- Direct message routing improvements and message store integration.

**Cloud & Workspace Management**
- Cloud link logic for workspace connectivity.
- Workspace persistence across container restarts and dynamic repo management.
- Workspace deployment fixes.

**Developer Experience**
- CLI patterns for agent visibility and log tailing.
- Codex state management and XTerm display improvements.

**Billing & Authentication**
- Billing bridge fixes and GitHub CLI auth support.
- Authentication tightening and token fetch improvements.

### Technical Perspective
**Architecture & Infrastructure**
- Multi-server architecture documentation and scalability adjustments.
- WebSocket ping/pong keepalive for main and bridge connections.

**Cloud Infrastructure**
- Cloud link migrations and update-workspaces workflow fixes.

**State Management**
- Message delivery fixes and Codex state persistence improvements.

**Deployment & Operations**
- Container entrypoint updates and deployment fixes.

**Documentation**
- Trail snippet bump and competitive analysis additions.

---

## [Week 2: January 10-17, 2026]

### Product Perspective
**Mobile & UI Improvements**
- Mobile scrolling fixes for XTermLogViewer and viewport stability.
- Dashboard UI restrictions/restore and agent list labeling cleanup.

**Channels & Messaging**
- Channel creation logging improvements.
- Message routing, duplication, and attribution fixes in cloud dashboard.

**Workspace & User Management**
- Workspace selector and user filtering fixes.
- Workspace proxy query parameter preservation.

**Agent Profiles & Coordination**
- Added agent profiles for multi-project support and Mega coordinator command.
- Trajectory viewer race condition fixes.

**Authentication & Providers**
- Gemini API key validation fixes and Claude login flow improvements.

### Technical Perspective
**Relay-PTY System Migration**
- Node-pty to Rust relay-pty migration with hybrid orchestrator.
- Relay-pty infrastructure tests and Rust 1.83 Cargo.lock v4 fixes.

**Performance & Reliability**
- Injection reliability improvements and duplicate terminal message fixes.
- Workspace ID sync fixes to avoid routing race conditions.

**State & Continuity**
- Continuity parsing and workspace path handling.

**Fallback Logic**
- Proper fallback logic and protocol prompt updates.

---

## [Week 3: January 17-24, 2026]

### Product Perspective
**Channels & Team Collaboration**
- Channel invites, endpoints, and message delivery fixes.
- Mobile channel scrolling and DM filtering in sidebar.
- Unified threading between channels and DMs.

**Performance & User Experience**
- 5x faster relay message injection latency.
- Mobile scrolling improvements and unified markdown rendering.
- Agent pin-to-top for agents panel.

**Developer Experience**
- Model selection dropdown sync and mapping consolidation.
- CLI tool bumps and SDK fixes.

**Workspace & Credentials**
- Workspace-scoped provider credentials.
- Workspace switching fixes and force-update workflow.

**Pricing & Documentation**
- Pricing updates and TASKS/protocol documentation refresh.
- Clarified agent roles (devops vs infrastructure).

### Technical Perspective
**Build System & CI/CD**
- Turborepo integration and concurrent Docker builds.
- Turbo/TypeScript build fixes and publish error remediation.

**Sync Messaging Protocol**
- Turn-based sync messaging with `[await]` syntax and ACK tracking.

**Daemon & Spawning**
- Daemon-based spawning with improved diagnostics and membership restore.
- Spawn timing race condition fixes.

**Cloud Infrastructure**
- Static file serving fixes, new `/api/bridge` endpoint, and routing fixes.
- Cloud sync heartbeat timeout handling and queue monitor fixes.

**Authentication & Git Operations**
- GitHub token fallback and GH_TOKEN injection fixes.
- Custom GitHub credential helper with improved retry logic.

**Workspace & Path Management**
- Workspace inbox namespacing and continuity parsing improvements.
