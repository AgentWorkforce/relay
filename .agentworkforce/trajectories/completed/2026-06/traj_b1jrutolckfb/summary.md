# Trajectory: Workspace-level event stream via relaycast 2.5.1

> **Status:** ❌ Abandoned
> **Started:** June 3, 2026 at 02:27 PM
> **Completed:** June 12, 2026 at 11:07 AM

---

## Key Decisions

### Port PR 888 telemetry lessons to current split

- **Chose:** Port PR 888 telemetry lessons to current split
- **Reasoning:** User requested Relaycast request attribution, install/update events, and MCP action-call telemetry while preserving UA-like harness values.

### Repaired broker-harness.ts to current SDK/harness-driver API and built eval suite on it

- **Chose:** Repaired broker-harness.ts to current SDK/harness-driver API and built eval suite on it
- **Reasoning:** Broker integration suite was pre-existingly broken: SDK narrowing moved BrokerEvent/HarnessDriverClient/SendMessageInput to @agent-relay/harness-driver and RelayCast to @relaycast/sdk; AgentRelay facade no longer does broker lifecycle. Fixed imports + removed the unused AgentRelay facade from BrokerHarness; added a dedicated evals/tsconfig.json compiling only evals/ + utils/ so eval:build is green without rewriting the still-broken sibling test files.

---

## Chapters

### 1. Work

_Agent: default_

- events.connect() falls back to the relaycast 2.5 workspace stream when no agent client; fixes relay#1031 so workspace relay.addListener streams. Bumped @relaycast/sdk to ^2.5.1. Also fixed pre-existing vitest-4 constructor-mock breakage in agent-relay.test.ts (main 'Test' workflow was red).: events.connect() falls back to the relaycast 2.5 workspace stream when no agent client; fixes relay#1031 so workspace relay.addListener streams. Bumped @relaycast/sdk to ^2.5.1. Also fixed pre-existing vitest-4 constructor-mock breakage in agent-relay.test.ts (main 'Test' workflow was red).
- Port PR 888 telemetry lessons to current split: Port PR 888 telemetry lessons to current split
- Repaired broker-harness.ts to current SDK/harness-driver API and built eval suite on it: Repaired broker-harness.ts to current SDK/harness-driver API and built eval suite on it
- Abandoned: Stale trajectory from 8 days ago, unrelated to current task
