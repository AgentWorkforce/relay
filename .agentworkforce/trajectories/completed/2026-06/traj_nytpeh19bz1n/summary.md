# Trajectory: Rename @agent-relay/runtime -> @agent-relay/harness-driver and RuntimeClient -> HarnessDriverClient for major release clarity

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** June 1, 2026 at 08:48 AM
> **Completed:** June 1, 2026 at 02:46 PM

---

## Summary

Expanded v8 docs for CLI, messaging, webhooks, and action callbacks; added focused pages for channel/DM/thread/reaction flows and integration surfaces; validated MDX and production build.

**Approach:** Standard approach

---

## Key Decisions

### Renamed @agent-relay/runtime -> @agent-relay/harness-driver; client RuntimeClient -> HarnessDriverClient (+ Options/Events/ProtocolError); kept domain terms AgentRuntime/HarnessRuntime/Spawn*Runtime*; added harness-driver to publish.yml publish-packages and publish-main-runtime-deps matrices

- **Chose:** Renamed @agent-relay/runtime -> @agent-relay/harness-driver; client RuntimeClient -> HarnessDriverClient (+ Options/Events/ProtocolError); kept domain terms AgentRuntime/HarnessRuntime/Spawn*Runtime*; added harness-driver to publish.yml publish-packages and publish-main-runtime-deps matrices
- **Reasoning:** Package drives harnesses, not a runtime itself; topology-neutral name; release pipeline must publish the new exact-version CLI dep or publish-main wait-gate times out

### Added create({ relay }) live-spawn to @agent-relay/harnesses PTY factories via a per-relay BrokerDriver (broker-binding.ts); handle keyed by registered agent name; README + compile-time proof updated to drop redundant register() for spawned agents

- **Chose:** Added create({ relay }) live-spawn to @agent-relay/harnesses PTY factories via a per-relay BrokerDriver (broker-binding.ts); handle keyed by registered agent name; README + compile-time proof updated to drop redundant register() for spawned agents
- **Reasoning:** User chose README-as-source-of-truth with create({relay}) spawning real PTY sessions; broker joins relay's workspace via RELAY_API_KEY env; status predicates match name-keyed events

### Document v8 from the current SDK-backed command groups

- **Chose:** Document v8 from the current SDK-backed command groups
- **Reasoning:** The existing v8 docs describe the intended product shape but omit concrete pages for the implemented CLI and messaging surfaces. The new docs will use the current command/API names and add versioned links for slugs that overlap v7.

---

## Chapters

### 1. Work

_Agent: default_

- Renamed @agent-relay/runtime -> @agent-relay/harness-driver; client RuntimeClient -> HarnessDriverClient (+ Options/Events/ProtocolError); kept domain terms AgentRuntime/HarnessRuntime/Spawn*Runtime*; added harness-driver to publish.yml publish-packages and publish-main-runtime-deps matrices: Renamed @agent-relay/runtime -> @agent-relay/harness-driver; client RuntimeClient -> HarnessDriverClient (+ Options/Events/ProtocolError); kept domain terms AgentRuntime/HarnessRuntime/Spawn*Runtime*; added harness-driver to publish.yml publish-packages and publish-main-runtime-deps matrices
- Added create({ relay }) live-spawn to @agent-relay/harnesses PTY factories via a per-relay BrokerDriver (broker-binding.ts); handle keyed by registered agent name; README + compile-time proof updated to drop redundant register() for spawned agents: Added create({ relay }) live-spawn to @agent-relay/harnesses PTY factories via a per-relay BrokerDriver (broker-binding.ts); handle keyed by registered agent name; README + compile-time proof updated to drop redundant register() for spawned agents
- Document v8 from the current SDK-backed command groups: Document v8 from the current SDK-backed command groups

---

## Artifacts

**Commits:** e5a505de, 0e246ee7, 6cc08ee8, 7df873b5, 1115feb9, f0822c79, dc30fab6, 2d67ee7e, 8b92acff, 7d6b3fd3, b1d2b7b5
**Files changed:** 97
