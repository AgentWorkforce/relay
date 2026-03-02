# Changelog

All notable changes to Agent Relay will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes
- **Task injection failures now return errors**: When spawning an agent with a task, if delivery fails after 3 retry attempts, spawn returns `success: false` and kills the agent. Previously, spawn would return `success: true` even if task injection silently failed, leaving zombie agents.

### Migration Guidance
- Callers of `relay.spawn()` with a `task` parameter should handle `success: false` results (though automatic retries make failures rare).
- Spawning without a task is unaffected and always succeeds.
- See the updated [Worker Orchestration guide](/docs/guides/worker-orchestration) for retry patterns.

### Added
- **CLI SSH Authentication**: New SSH-based authentication for CLI local auth workflows, enabling secure agent spawning and communication (#648e7782).
- **Multi-Repository Spawning**: Agents can now be spawned across multiple repositories in a single operation, improving orchestration flexibility (#2d2bf610).
- **Model Hotswap**: Runtime model switching for agents, allowing dynamic provider and model changes without restart (#5a80bdc0).
- **Prerelease Publishing**: New prerelease script for staging environment, enabling faster iteration and testing cycles (#495428cd).

### Fixed
- Task injection failures are no longer silent - spawn properly returns an error when delivery fails.
- Zombie agents (spawned but never received their task) are now cleaned up automatically.
- Automatic retry (3 attempts with 2s delays) for task injection improves reliability.
- **Breaking cache removed**: Removed cache logic that caused agent initialization failures (#d1166cf9).
- **Better-sqlite3 optional in tests**: Database dependency now properly marked as optional for test environments, improving CI reliability (#190611b7).
- Doctor command now correctly validates test expectations for partial driver availability (#9b545ff9).

## [3.0.2] - 2026-03-02

### Product Perspective
#### User-Impacting Fixes
- Resolve platform-specific broker binary in SDK (#464) (#464)
- Use SDK join_channel API for broker channel joins
- Remove relay-pty references from postinstall.js
- Update verify-install to check for agent-relay-broker instead of relay-pty
- Remove redundant registration map_err conversion

### Technical Perspective
#### Performance & Reliability
- Stabilize macOS CLI agents timeout
- Allow SDK broker fallback in macOS npx verify
- Accept SDK broker fallback in npx resolution check
- Fix verify-publish PR package resolution
- Accept both relaycast workspace key field shapes
- Restore coverage threshold and fix sdk integration type
- Retrigger checks

#### Dependencies & Tooling
- Use published relaycast 0.3.0 crate

#### Releases
- v3.0.2

---

## [2.3.16] - 2026-03-02

### Product Perspective
#### User-Impacting Fixes
- Resolve platform-specific broker binary in SDK (#464) (#464)
- Use SDK join_channel API for broker channel joins
- Remove relay-pty references from postinstall.js
- Update verify-install to check for agent-relay-broker instead of relay-pty
- Remove redundant registration map_err conversion

### Technical Perspective
#### Performance & Reliability
- Stabilize macOS CLI agents timeout
- Allow SDK broker fallback in macOS npx verify
- Accept SDK broker fallback in npx resolution check
- Fix verify-publish PR package resolution
- Accept both relaycast workspace key field shapes
- Restore coverage threshold and fix sdk integration type
- Retrigger checks

#### Dependencies & Tooling
- Use published relaycast 0.3.0 crate

#### Releases
- v2.3.16

---

## [2.3.14] - 2026-02-19

### Technical Perspective
#### Dependencies & Tooling
- Auto-generate CHANGELOG on stable release (#447) (#447)

#### Releases
- v2.3.14

---

## [2.1.5] - 2026-01-30

### Product Perspective
#### User-Facing Features & Improvements
- **Task injection retries**: Spawning agents with tasks now automatically retries delivery up to 3 times, preventing silent failures that left agents without their initial instructions.

#### User-Impacting Fixes
- Auto-suggestion injection and cursor-agent reconciliation fixed — agents now correctly receive suggestions and cursor state stays in sync (#347).

### Technical Perspective
#### Architecture & API Changes
- Injection retry logic added to spawn flow with configurable attempts and backoff (#349).
- Cursor-agent reconciliation ensures agent state matches the editor's cursor position after reconnects.

#### Releases
- v2.1.4, v2.1.5

---

## [2.1.3] - 2026-01-29

### Product Perspective
#### User-Facing Features & Improvements
- **Agent-to-agent JSONL watch**: Agents can now observe each other's activity streams via JSONL watch, enabling real-time coordination (#346).
- **Onboarding improvements**: Smoother first-run experience with better prompts and flow handling (#345).
- **SQLite dependency removed**: Storage layer switched from SQLite to JSONL, reducing native binary requirements and simplifying installation (#343).

#### User-Impacting Fixes
- Relay-pty binary resolution fixed for `npx` usage — no longer requires postinstall scripts, making global installs more reliable (#344).
- Messages path routing corrected for dashboard storage (#341).

### Technical Perspective
#### Architecture & API Changes
- Storage backend migrated from SQLite to JSONL flat files, eliminating the native `better-sqlite3` dependency.
- Relay-pty binary resolution rewritten with comprehensive edge case handling for npx, global installs, and monorepo setups.
- Agent-to-agent JSONL watch enables streaming observation of peer agent activity.

#### Performance & Reliability
- Comprehensive test suite added for relay-pty binary path resolution across install scenarios.
- Bundled dependency audit added to CI (#339).
- Timeout and skip logic for x64 macOS verification on PRs (#340).

#### Dependencies & Tooling
- Removed `better-sqlite3` native dependency in favor of JSONL storage.
- macOS x64 verification job removed from CI (slow, low value).

#### Releases
- v2.1.0, v2.1.1, v2.1.2, v2.1.3 (plus v2.0.34–v2.0.37)

---

## [2.0.37] - 2026-01-28

### Product Perspective
#### User-Facing Features & Improvements
- **OpenCode HTTP API integration**: Full OpenCode provider support via HTTP API, enabling OpenCode as a first-class agent backend (#337).
- **File-based continuity**: Agents can now save and restore session state through file-based continuity commands, surviving restarts and long operations (#331).
- **Performance benchmarking**: New benchmarking package for comparing agent configurations and measuring swarm performance (#326).
- **MCP client parity**: MCP client now aligned with SDK for consistent behavior across both integration paths (#323).

#### User-Impacting Fixes
- **Unbounded output buffer crash fixed**: `RangeError` from large agent output no longer crashes the process (#338).
- Storage health reporting and doctor CLI now correctly handle JSONL storage (#334, #335).
- Stale agents cleaned up automatically when their process dies without a clean disconnect (#319).
- CJS exports fixed for `agent-relay` and `@agent-relay/utils` — CommonJS consumers can now `require()` the packages (#325, #328).

### Technical Perspective
#### Architecture & API Changes
- OpenCode HTTP API integration adds a new provider adapter for the OpenCode backend.
- File-based continuity command handling added to orchestrator for session persistence.
- New `listConnectedAgents()` and `removeAgent()` APIs for programmatic agent management.
- Shared client helpers extracted to `@agent-relay/utils` for SDK/MCP consistency.
- MCP client aligned with SDK: `sendAndWait` return types updated to `AckPayload`, `PROTOCOL_VERSION` imported consistently.
- Agent capacity increased to support 10,000 concurrent agents (#318).

#### Performance & Reliability
- Output buffer bounds enforced to prevent `RangeError` crashes from large payloads.
- Storage reliability and security fixes: health checks, doctor diagnostics, and JSONL handling hardened.
- Stale agent cleanup on process death prevents ghost entries in connected agent lists.
- Relay-pty binary fallback logic improved for cross-platform resolution (#324).

#### Dependencies & Tooling
- Post-publish verification workflow added for npm packages with npx, Docker, and macOS tests (#323).
- CJS build artifacts generated during `npm pack` for dual ESM/CJS support.
- Bundled dependencies ensure tarball includes all `@agent-relay` packages.
- macOS CI runners updated (macos-13 → macos-15-large, macos-12 for Intel x64).
- Dashboard publishing removed from relay monorepo (moved to relay-cloud).
- PostHog analytics added to docs site (#321).

#### Releases
- v2.0.21–v2.0.32, plus numerous CI and packaging fixes.

---

## [2.0.25] - 2026-01-27

### Product Perspective
#### User-Facing Features & Improvements
- **Dashboard moved to relay-cloud**: Dashboard package removed from the relay monorepo and migrated to the dedicated relay-cloud repository, simplifying the core package.
- **CLI dashboard startup**: `--dashboard` flag now launches the dashboard via npx fallback when not locally available (#322).
- **Socket length handling**: Long socket messages no longer truncated or malformed (#317).
- **Stale agent cleanup**: Agents whose processes die without clean disconnect are now automatically removed (#319).
- **10K agent capacity**: Relay server now supports up to 10,000 concurrent connected agents (#318).

#### User-Impacting Fixes
- Dashboard references cleaned up after package removal to prevent broken imports.
- Socket.rs `warn!` macro indentation corrected for proper Rust compilation.
- CLI tests isolated from running daemon to prevent interference.

### Technical Perspective
#### Architecture & API Changes
- Dashboard package fully removed; CI updated to test daemon via socket instead of HTTP (#315, #316).
- `listConnectedAgents()` and `removeAgent()` APIs added for agent lifecycle management (#319).
- Agent capacity limit raised to 10,000 (#318).
- Socket length handling improved in Rust relay-pty core (#317).

#### Performance & Reliability
- Stale agent cleanup prevents ghost entries when processes exit uncleanly.
- CLI tests no longer conflict with a running local daemon.

#### Dependencies & Tooling
- Dashboard publishing workflow removed; package cleanup across workspaces (#315, #320).
- PostHog analytics added to documentation site (#321).
- npx fallback added for dashboard startup in CLI.

#### Releases
- v2.0.21–v2.0.25

---

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
