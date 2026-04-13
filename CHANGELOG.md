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
- **`--api-bind` flag for broker HTTP API**: Configures the bind address for the broker's HTTP/WS server (default: `127.0.0.1`). Use `--api-bind 0.0.0.0` when running inside Daytona sandboxes to accept remote connections from the desktop app.
- **`write_pty` PTY worker message**: New protocol message type that writes arbitrary data to the PTY. Used internally by the broker's `send_input` handler. The PTY worker responds with `ok` (including `bytes_written`) or `worker_error`.

### Fixed

- Task injection failures are no longer silent - spawn properly returns an error when delivery fails.
- Zombie agents (spawned but never received their task) are now cleaned up automatically.
- Automatic retry (3 attempts with 2s delays) for task injection improves reliability.
- **Breaking cache removed**: Removed cache logic that caused agent initialization failures (#d1166cf9).
- **Better-sqlite3 optional in tests**: Database dependency now properly marked as optional for test environments, improving CI reliability (#190611b7).
- Doctor command now correctly validates test expectations for partial driver availability (#9b545ff9).
- **`sendInput` now routes through PTY worker protocol**: Previously `sendInput` wrote raw bytes to the PTY worker's stdin, which the worker's JSON parser rejected silently. Input never reached the PTY. Now `sendInput` sends a proper `write_pty` protocol frame, and the PTY worker writes the data to the actual PTY.

## [4.0.19] - 2026-04-13

### Product Perspective
#### User-Impacting Fixes
- Make preParseWorkflowFile async to avoid Bun-compiled CLI hang (#733) (#733)

### Technical Perspective
#### Releases
- v4.0.19

---

## [4.0.18] - 2026-04-13

### Product Perspective
#### User-Impacting Fixes
- Add progress diagnostics and spawnSync to runScriptFile (#731) (#731)
- History/inbox fetch workspace_key via broker HTTP API (#729) (#729)

### Technical Perspective
#### Releases
- v4.0.18

---

## [4.0.17] - 2026-04-13

### Product Perspective
#### User-Facing Features & Improvements
- **Workerd export condition + narrow entry + workers-safety probe (#726)** (#726)

#### User-Impacting Fixes
- Restore packages/sdk vitest suite to green (#728) (#728)
- Pre-parse workflow script files with actionable error hints (#727) (#727)
- Make --resume work for script workflows (#725) (#725)

### Technical Perspective
#### Releases
- v4.0.17

---

## [4.0.16] - 2026-04-12

### Product Perspective

#### User-Impacting Fixes

- Wire relaycast MCP for headless opencode spawner (#723) (#723)

### Technical Perspective

#### Releases

- v4.0.16

---

## [4.0.15] - 2026-04-12

### Product Perspective

#### User-Impacting Fixes

- History and inbox work without RELAY_API_KEY env var (#722) (#722)

### Technical Perspective

#### Releases

- v4.0.15

---

## [4.0.14] - 2026-04-11

### Product Perspective

#### User-Facing Features & Improvements

- **Add cloud cancel CLI + fix opencode headless spawn (#721)** (#721)

### Technical Perspective

#### Releases

- v4.0.14

---

## [4.0.13] - 2026-04-11

### Product Perspective

#### User-Impacting Fixes

- Retry real install paths in verify-publish (#719) (#719)

### Technical Perspective

#### Releases

- v4.0.13

---

## [4.0.12] - 2026-04-11

### Product Perspective

#### User-Facing Features & Improvements

- **Add workflow for relay bootstrap and messaging fixes (#708)** (#708)
- **Add meta and clean-room relay validation workflows (#713)** (#713)

### Technical Perspective

#### Releases

- v4.0.12

---

## [4.0.11] - 2026-04-10

### Product Perspective

#### User-Impacting Fixes

- Log full deterministic step output on failure for cloud visibility (#716) (#716)

### Technical Perspective

#### Releases

- v4.0.11

---

## [4.0.10] - 2026-04-10

### Product Perspective

#### User-Impacting Fixes

- Skip in-sandbox provisioning when cloud launcher already seeded ACLs (#711) (#711)
- Harden macos binary smoke checks (#710) (#710)

### Technical Perspective

#### Performance & Reliability

- Harden macos binary verification (#709) (#709)

#### Releases

- v4.0.10

---

## [4.0.9] - 2026-04-10

### Product Perspective

#### User-Impacting Fixes

- Harden npm publish packaging (#707) (#707)
- Use bun built-in TS validation, remove esbuild dependency (#706) (#706)
- Npm tarball propagation race in verify-publish and install.sh (#705) (#705)

### Technical Perspective

#### Releases

- v4.0.9

---

## [4.0.6] - 2026-04-10

### Product Perspective

#### User-Facing Features & Improvements

- **Complete implementation + fix Supermemory adapter (#700)** (#700)

### Technical Perspective

#### Releases

- v4.0.6

---

## [4.0.5] - 2026-04-08

### Technical Perspective

#### Architecture & API Changes

- Route waitlist signups to cloud

#### Releases

- v4.0.5

---

## [4.0.4] - 2026-04-07

### Product Perspective

#### User-Impacting Fixes

- Use local workspace session for symlink/solo mode to avoid 405 on cloud API (#692) (#692)

### Technical Perspective

#### Releases

- v4.0.4

---

## [4.0.3] - 2026-04-07

### Product Perspective

#### User-Facing Features & Improvements

- **Fast workspace seeding — symlink mount + tar bulk upload (#691)** (#691)
- **30 workflows to wire relayauth/relayfile permissions into workflow runner (#673)** (#673)

#### User-Impacting Fixes

- Only prefer sibling relay-dashboard dev build when RELAY_LOCAL_DEV=1 (#690) (#690)
- Install broker binary to BIN_DIR so it's on PATH (#689) (#689)

### Technical Perspective

#### Releases

- v4.0.3

---

## [4.0.2] - 2026-04-07

### Technical Perspective

#### Releases

- v4.0.2

---

## [4.0.1] - 2026-04-06

### Product Perspective

#### User-Facing Features & Improvements

- **TDD refactoring workflows for runner.ts + main.rs decomposition (#675)** (#675)
- **/schedule — RelayCron landing page**
- **Auto-download relayfile-mount binary on first use (#670)** (#670)

#### User-Impacting Fixes

- Allow anonymous workspace creation in agent-relay on (#683) (#683)
- Wire .agentignore/.agentreadonly enforcement into agent-relay on (#671) (#671)

### Technical Perspective

#### Dependencies & Tooling

- Gitignore .trajectories/ (automated run artifacts) (#676) (#676)

#### Releases

- v4.0.1

---

## [4.0.0] - 2026-03-31

### Product Perspective

#### User-Facing Features & Improvements

- **Default agent-relay on to production cloud endpoints (#667)** (#667)
- **Unified workspace ID across relay services (#664)** (#664)

### Technical Perspective

#### Releases

- v4.0.0

---

## [3.2.22] - 2026-03-27

### Technical Perspective

#### Releases

- v3.2.22

---

## [3.2.21] - 2026-03-27

### Product Perspective

#### User-Impacting Fixes

- Avoid E2BIG spawn failure and verification token double-count (#655) (#655)
- Queue outbound messages during RelayObserver reconnect (#646) (#646)

### Technical Perspective

#### Releases

- v3.2.21

---

## [3.2.18] - 2026-03-25

### Product Perspective

#### User-Impacting Fixes

- Remove unused dm_drops_total function to fix clippy dead-code warning (#645) (#645)

### Technical Perspective

#### Releases

- v3.2.18

---

## [3.2.17] - 2026-03-25

### Product Perspective

#### User-Facing Features & Improvements

- **Add dry-run support and stream CLI output to terminal (#643)** (#643)

#### User-Impacting Fixes

- Resolve DM participants for correct routing (#644) (#644)

### Technical Perspective

#### Releases

- v3.2.17

---

## [3.2.16] - 2026-03-25

### Product Perspective

#### User-Facing Features & Improvements

- **Add http and broker-path subpath exports for Electron apps (#640)** (#640)
- **PTY output streaming workflow (#390) (#528)** (#390)
- **Add integration step type for external services (#631)** (#631)
- **Add dynamic channel subscribe/unsubscribe to broker (#630)** (#630)
- **Cloud endpoints, API executor, and Communicate SDK v2 protocol (#632)** (#632)
- **Communicate Mode SDK (on_relay) for Python and TypeScript (#618)** (#618)
- **Add wait/steer message injection modes**

#### User-Impacting Fixes

- Add RELAY_SKIP_PROMPT and self-echo filtering (#641) (#641)
- Ignore failing relaycast DM tests pending relaycast 1.0 API investigation
- Cargo fmt corrections
- Sync lockfile for new UI deps
- Validate channel names at build time and dry-run (#638) (#638)
- Forward steer mode through relaycast DMs
- Unblock fork PR checks and enforce steer rejection for relaycast DM
- Propagate inbound injection mode on relay_inbound events
- Allow relaycast delivery path to accept steer mode
- Reject steer mode on relaycast-only send path
- Validate send mode and harden steer delivery semantics
- Satisfy rust fmt/clippy for injection mode changes
- Don't block steer injections behind autosuggest gate

### Technical Perspective

#### Performance & Reliability

- Assert injection mode defaults to wait when omitted
- Fix missing MessageInjectionMode imports in test modules

#### Dependencies & Tooling

- Bump relaycast crate to v1 for injection mode support

#### Releases

- v3.2.16

---

## [3.2.15] - 2026-03-23

### Product Perspective

#### User-Facing Features & Improvements

- **Add RelayObserver proxy client for UI consumers (#627)** (#627)

#### User-Impacting Fixes

- Add bypass flag to codex non-interactive spawns (#628) (#628)

### Technical Perspective

#### Releases

- v3.2.15

---

## [3.2.14] - 2026-03-23

### Product Perspective

#### User-Facing Features & Improvements

- **Add initial Swift SDK and harden workflow output (#589)** (#589)

#### User-Impacting Fixes

- Make og image compatible with OpenNext
- Track generated SST resource types
- Avoid generated SST type dependency

### Technical Perspective

#### Dependencies & Tooling

- Rename SST app to relay-web

#### Releases

- v3.2.14

---

## [3.2.13] - 2026-03-20

### Product Perspective

#### User-Impacting Fixes

- Ignore non-zero exit codes for opencode non-interactive agents (#602) (#602)

### Technical Perspective

#### Releases

- v3.2.13

---

## [3.2.12] - 2026-03-20

### Product Perspective

#### User-Facing Features & Improvements

- **Add Codex relay skill for sub-agent communication (#595)** (#595)

### Technical Perspective

#### Releases

- v3.2.12

---

## [3.2.11] - 2026-03-20

### Product Perspective

#### User-Facing Features & Improvements

- **Add workflow defaults abstraction (#599)** (#599)

#### User-Impacting Fixes

- Detect Codex boot marker format in PTY startup gate (#600) (#600)
- Consolidate CLI path resolution (#598) (#598)
- Reduce WS spawn pre-registration timeout from 15s to 3s (#597) (#597)

### Technical Perspective

#### Releases

- v3.2.11

---

## [3.2.10] - 2026-03-20

### Product Perspective

#### User-Facing Features & Improvements

- **Workflow to polish CLI output with listr2 + chalk (#585)** (#585)
- **CLI session collectors, step-level cwd, and run summary table (#592)** (#592)

#### User-Impacting Fixes

- Auto-build local sdk workflows runtime (#588) (#588)
- MCP tools unavailable for agents spawned via agent_add (#591) (#591)

### Technical Perspective

#### Releases

- v3.2.10

---

## [3.2.9] - 2026-03-19

### Technical Perspective

#### Releases

- v3.2.9

---

## [3.2.8] - 2026-03-18

### Product Perspective

#### User-Impacting Fixes

- Detect claude CLI with inline args for MCP injection (#584) (#584)

### Technical Perspective

#### Releases

- v3.2.8

---

## [3.2.7] - 2026-03-18

### Product Perspective

#### User-Impacting Fixes

- Forward RELAY_WORKSPACES_JSON and RELAY_DEFAULT_WORKSPACE to spawned agent MCP config (#583) (#583)

### Technical Perspective

#### Releases

- v3.2.7

---

## [3.2.6] - 2026-03-17

### Product Perspective

#### User-Facing Features & Improvements

- **Add reasoning effort metadata to model registry (#579)** (#579)
- **Add resize_pty protocol message for remote PTY resize**

#### User-Impacting Fixes

- Ensure spawned Claude agents get proper MCP config (#581) (#581)
- Address PR review feedback for resize_pty

### Technical Perspective

#### Releases

- v3.2.6

---

## [3.2.5] - 2026-03-17

### Technical Perspective

#### Releases

- v3.2.5

---

## [3.2.4] - 2026-03-17

### Product Perspective

#### User-Facing Features & Improvements

- **StartFrom + deterministic/worktree step parity (#574)** (#574)
- **A2A protocol transport layer — Python (89 tests ✅) + TypeScript**
- **Add OpenClaw orchestrator skill for headless multi-agent sessions**
- **Add TS adapters for OpenAI Agents, LangGraph, Google ADK, CrewAI + review fixes**
- **Add Pi RPC adapter for Python SDK + verify TS Pi adapter exports**
- **Add Communicate Mode SDK (on_relay) for Python and TypeScript**

#### User-Impacting Fixes

- Address latest Devin review findings
- Move framework adapters from dependencies to optional peerDependencies
- Update TS test mock servers to match actual Relaycast API paths
- Address remaining Devin review findings
- Exclude all test files from SDK tsconfig.json too
- Exclude all test files from SDK build config
- Address Devin review findings on Communicate SDK
- Address Barry review feedback on Communicate SDK
- Address Will + Devin review feedback on Communicate SDK
- Address PR #565 review — remove onRelay auto-detect, fix ReDoS regex (#565)
- RegisterOrRotate for 409, ws.close timeout, add @sinclair/typebox dep for Pi adapter
- Align Python SDK transport with real Relaycast API surface
- Address Devin review findings
- Exclude vitest test files from SDK build config
- Add @sinclair/typebox to root dependencies for global install
- Address PR #565 review feedback (#565)
- Communicate mode spec compliance — adapters, tests, infra
- Critical spec compliance issues from deep review
- Spec compliance — ping/pong, auto-detect module matching
- Add per-adapter subpath exports and withRelay alias
- Sync package-lock.json with package.json

### Technical Perspective

#### Performance & Reliability

- Add 13 e2e tests for all TS + Python adapters against live Relaycast

#### Dependencies & Tooling

- Hide communicate pages from public docs until tested
- Sync package-lock.json after config version bump

#### Releases

- v3.2.4

---

## [3.2.3] - 2026-03-15

### Product Perspective

#### User-Facing Features & Improvements

- **Add HTTP transport mode; route all CLI commands through SDK**

#### User-Impacting Fixes

- Use correct broker init subcommand and --api-port flag (#569)
- Use broker binary path instead of process.argv[1] for auto-start (#569)
- Add RELAY_SKIP_BOOTSTRAP to Codex, Opencode, and Gemini/Droid config paths
- Auto-accept droid/opencode permission prompts with --cwd
- Set RELAY_SKIP_BOOTSTRAP when agent token is pre-registered (#85)
- Auto-accept droid/opencode permission prompts with --cwd
- Address review feedback on HTTP client and listing commands
- Auto-accept Claude Code folder trust prompt for spawned agents

### Technical Perspective

#### Performance & Reliability

- Add tests for droid/opencode auto-accept permission detection
- Add tests for droid/opencode auto-accept permission detection

#### Releases

- v3.2.3

---

## [3.2.2] - 2026-03-14

### Product Perspective

#### User-Facing Features & Improvements

- **Package plugins as proper platform formats and PRPM collections**
- **Implement CLI native plugins for OpenCode, Claude Code, and Gemini CLI**
- **Add deterministic step support to WorkflowBuilder**

#### User-Impacting Fixes

- Suppress codex update prompt in spawned workers
- Remove relay.shutdown() that killed the running broker in status command
- Add jq availability check in before-model-inject.sh
- Make broker API port discovery injectable for testability
- Status command spawns new broker instead of connecting to existing one
- Address Devin review round 2 — error handling, state mutation order, message limit
- Address Devin PR review comments
- Address minor verification gaps across all 3 plugins
- Idle verification loop handles single-fire agent_idle events
- Idle verification loop mirrors runVerification double-occurrence guard
- Non-lead agents in hub-spoke should use idle-as-complete
- Address Devin review feedback on PR #566 (#566)
- Use ref-counted Map for activeReviewers instead of Set
- WorkflowBuilder drops preset field and reviewer double-booking

### Technical Perspective

#### Dependencies & Tooling

- Update MCP tool name references to 3-level hierarchy (#564) (#564)

#### Releases

- v3.2.2

---

## [3.2.1] - 2026-03-13

### Product Perspective

#### User-Facing Features & Improvements

- **Point-person-led completion pipeline (#552)** (#552)

### Technical Perspective

#### Releases

- v3.2.1

---

## [3.2.0] - 2026-03-13

### Product Perspective

#### User-Facing Features & Improvements

- **Deterministic workspace key from user + directory (#549)** (#549)

#### User-Impacting Fixes

- Pass --model flag to spawned CLI processes (#559) (#559)
- Rebind relaycast tokens after workspace switch (#558) (#558)
- Update MCP tool name references to dot-notation hierarchy (#555) (#555)
- Inject inter-agent DMs via workspace WebSocket (#553) (#553)
- Exact flag matching for --mcp-config guard (#550) (#550)

### Technical Perspective

#### Architecture & API Changes

- Move skills to dedicated directory with symlinks (#561) (#561)

#### Performance & Reliability

- Add workflow smoke matrix for codex and gemini (#544) (#544)

#### Releases

- v3.2.0

---

## [3.1.23] - 2026-03-12

### Technical Perspective

#### Releases

- v3.1.23

---

## [3.1.22] - 2026-03-11

### Product Perspective

#### User-Impacting Fixes

- Install parity and spawn deserialization fallback (#541) (#541)
- Preserve user MCP servers when spawning Claude from dashboard (#542) (#542)
- Codex bypass flag → --dangerously-bypass-approvals-and-sandbox (#540) (#540)

### Technical Perspective

#### Releases

- v3.1.22

---

## [3.1.21] - 2026-03-11

### Product Perspective

#### User-Facing Features & Improvements

- **Wire workspaceName/relaycastBaseUrl options in AgentRelay (#538)** (#538)
- **Add multi-workspace support to OpenClaw bridge**
- **Add skipRelayPrompt flag to skip MCP config injection on spawn** (#419)
- **Wire multi-workspace runtime flows**
- **Add multi-workspace auth plumbing**

#### User-Impacting Fixes

- SwitchWorkspace clawName, stale alias default, and corrupt JSON handling
- Preserve skip_relay_prompt on restart
- Reset exit info per retry + preserve exit code on spawn failure
- Avoid wiping workspace alias/id when add-workspace updates without flags
- Use timeoutMs directly in nudge loop timeout guard
- Forward skip_relay_prompt in Python SDK and skip pre-registration in broker
- Workspace default handling in add-workspace
- Harden multi-workspace add-workspace default and logging behavior
- Distinguish force-released (nudge exhaustion) from released (idle-complete)
- Address PR #531 review feedback in workflow runner (#531)
- Always record failed attempt output for workflow retries
- Pass skipRelayPrompt through spawner headless path and simplify Rust type
- Include exitCode and exitSignal in step events (#499) (#499)
- Escape TOML string values for codex --config workspace env vars
- Treat force-released agent as step failure, not success (#498)
- Correct error message for default workspace lookup failure and forward workspace env vars in MCP snippets
- Use workspace-scoped dedup keys for MCP self-echo pre-seeding
- Allow clippy too_many_arguments on MultiWorkspaceSession::new
- Address multi-workspace code review bugs from PR #519 (#519)
- Restore carriage return in wrap retry PTY injection

### Technical Perspective

#### Dependencies & Tooling

- Record multi-workspace implementation trail

#### Releases

- v3.1.21

---

## [3.1.19] - 2026-03-10

### Product Perspective

#### User-Impacting Fixes

- Resolve install binary verification, uninstall, and version prefix bugs (#535) (#535)

### Technical Perspective

#### Releases

- v3.1.19

---

## [3.1.18] - 2026-03-10

### Product Perspective

#### User-Facing Features & Improvements

- **Multi-workspace runtime support (#519)** (#519)
- **Harden handoffs with auto step owners + per-step reviews (#511)** (#511)

#### User-Impacting Fixes

- Rebase release commit on latest main before pushing (#533) (#533)
- Guard specialist promise in executor supervised path (#525) (#525)
- Avoid rotating relay agent token on setup (#520) (#520)

### Technical Perspective

#### Releases

- v3.1.18

---

## [3.1.15] - 2026-03-09

### Technical Perspective

#### Releases

- v3.1.15

---

## [3.1.14] - 2026-03-09

### Product Perspective

#### User-Impacting Fixes

- Prevent race condition in relay WS handler binding (#515) (#515)

### Technical Perspective

#### Releases

- v3.1.14

---

## [3.1.13] - 2026-03-09

### Product Perspective

#### User-Impacting Fixes

- Bind relay event handlers after WS connect (#513) (#513)
- Expose all workspace DM conversations in dashboard (#510) (#510)

### Technical Perspective

#### Releases

- v3.1.13

---

## [3.1.12] - 2026-03-07

### Technical Perspective

#### Releases

- v3.1.12

---

## [3.1.11] - 2026-03-07

### Technical Perspective

#### Releases

- v3.1.11

---

## [3.1.10] - 2026-03-05

### Product Perspective

#### User-Impacting Fixes

- Quote make_latest to prevent openclaw release from hijacking latest (#496) (#496)

### Technical Perspective

#### Releases

- v3.1.10

---

## [3.1.9] - 2026-03-05

### Technical Perspective

#### Releases

- v3.1.9

---

## [3.1.8] - 2026-03-05

### Technical Perspective

#### Releases

- v3.1.8

---

## [3.1.7] - 2026-03-05

### Technical Perspective

#### Releases

- v3.1.7

---

## [3.1.5] - 2026-03-04

### Technical Perspective

#### Releases

- v3.1.5

---

## [3.1.4] - 2026-03-04

### Technical Perspective

#### Releases

- v3.1.4

---

## [3.1.3] - 2026-03-04

### Technical Perspective

#### Releases

- v3.1.3

---

## [3.1.2] - 2026-03-04

### Technical Perspective

#### Releases

- v3.1.2

---

## [3.1.1] - 2026-03-04

### Product Perspective

#### User-Facing Features & Improvements

- **Add openclaw-relaycast package (#474)** (#474)

#### User-Impacting Fixes

- Remove unsupported dashboard flag from dev script

### Technical Perspective

#### Releases

- v3.1.1

---

## [3.1.0] - 2026-03-04

### Product Perspective

#### User-Facing Features & Improvements

- **Make provider spawn transport-driven**
- **Add direct spawn/message API (#473)** (#473)

#### User-Impacting Fixes

- Make SDK lifecycle release test more robust (#471) (#471)

### Technical Perspective

#### Architecture & API Changes

- Switch runtime contract to provider-driven headless

#### Performance & Reliability

- Align contract fixture checks with broker event shapes

#### Releases

- v3.1.0

---

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
