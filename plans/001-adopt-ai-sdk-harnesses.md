# Plan 001: Make AI SDK harness adapters Relay's primary headless runtime

> **Executor instructions**: Follow the steps in order. Run each verification command and confirm the expected result before continuing. Stop and report if a STOP condition occurs. When complete, update this plan's status in `plans/README.md`.
>
> **Drift check**:
>
> ```bash
> git diff --stat 765e42535..HEAD -- package.json package-lock.json .github packages/harnesses packages/harness-driver packages/sdk packages/cli crates/broker tests README.md CHANGELOG.md
> ```
>
> If an in-scope contract has changed, compare it with the current-state notes below before implementation.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: migration / direction
- **Planned at**: Relay commit `765e42535`, 2026-07-15

## Outcome

Relay uses official AI SDK harness adapters as its default headless runtime for Claude Code, Codex, OpenCode, and Pi after each adapter passes contract and soak gates. Deep Agents is available as an experimental adapter with capability-accurate lifecycle behavior.

The existing PTY runtime remains available for native terminal sessions and remains the default for harnesses without an AI SDK adapter. AI SDK sessions support `agent attach` through a semantic event view instead of terminal emulation.

Relay requires Node 22 across packages, CI, installation, and documentation.

Relay adopts the AI SDK harness stream as its reference observability profile. Relaycast publishes the same canonical activity and semantic event vocabulary for every runtime. AI SDK events populate that profile directly; PTY runtimes populate the same profile from structured CLI output and terminal evidence with explicit fidelity metadata.

## Why this matters

Relay currently owns provider-specific startup, flags, injection, lifecycle, and recovery behavior for each coding harness. The AI SDK adapters move those runtime details behind one typed contract, reducing duplicate integration code and giving Relay a consistent path for active input, lifecycle management, events, and new harness support.

Relay continues to own its durable coordination layer: agent identity, messaging, delivery receipts, supervision, and attach. The integration is successful when adapter updates are absorbed through one registry and contract suite instead of changes scattered across provider-specific wrappers.

Applications built on Relay should receive the richest portable view of an agent without knowing which runtime produced it. A declared observability profile lets consumers distinguish exact structured events from inferred PTY activity and gives every harness integration a concrete parity target.

## Runtime selection

Harness creation accepts:

```ts
backend?: 'auto' | 'ai-sdk' | 'pty';
```

- `auto` selects a validated AI SDK adapter when registered; otherwise it selects PTY.
- `ai-sdk` requires a registered, enabled adapter and successful preflight.
- `pty` selects the existing terminal runtime.
- Runtime selection completes before session creation. A started session stays on its selected runtime.

## Support matrix

| Harness     | AI SDK package                | Initial state | PTY path | Target state                          |
| ----------- | ----------------------------- | ------------- | -------- | ------------------------------------- |
| Claude Code | `@ai-sdk/harness-claude-code` | experimental  | existing | AI SDK default after gates            |
| Codex       | `@ai-sdk/harness-codex`       | experimental  | existing | AI SDK default after gates            |
| OpenCode    | `@ai-sdk/harness-opencode`    | experimental  | existing | AI SDK default after gates            |
| Pi          | `@ai-sdk/harness-pi`          | experimental  | none     | AI SDK default after gates            |
| Deep Agents | `@ai-sdk/harness-deepagents`  | experimental  | none     | experimental with tested capabilities |
| Gemini      | none                          | PTY           | existing | PTY                                   |
| Cursor      | none                          | PTY           | existing | PTY                                   |
| Droid       | none                          | PTY           | existing | PTY                                   |
| Aider       | none                          | PTY           | existing | PTY                                   |
| Goose       | none                          | PTY           | existing | PTY                                   |
| Grok        | none                          | PTY           | existing | PTY                                   |

## Target architecture

| Responsibility                                                      | Component                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| Provider bootstrap, auth, model settings, bridge protocol           | Official AI SDK harness adapter                       |
| Session start, prompt turns, lifecycle, stream vocabulary           | Public `HarnessV1` contract                           |
| Active user-message injection                                       | Relay harness host retaining `HarnessV1PromptControl` |
| Local filesystem, processes, bootstrap cache, loopback bridge ports | Relay local-host sandbox provider                     |
| Durable inbox and delivery acknowledgements                         | Existing Relay `DeliveryRunner` and broker            |
| Agent identity, channels, threads, actions                          | Existing Relay SDK                                    |
| AI SDK process supervision and semantic replay                      | Relay broker plus Node 22 sidecar                     |
| Human and machine attach output                                     | Relay CLI semantic renderer                           |
| Native terminal sessions and unsupported harnesses                  | Existing Relay PTY runtime                            |
| Canonical activity, semantic events, fidelity, and capabilities     | Relay SDK and Relaycast                               |

The broker-supervised sidecar hosts the AI SDK session because `agent attach` runs in a separate process. `HarnessV1PromptControl` remains inside the sidecar; the broker exchanges versioned semantic commands, events, and acknowledgements with it.

## Canonical observability profile

Keep durable session status and high-frequency agent activity as separate dimensions. Existing `AgentSessionStatus` continues to answer whether the session is active, idle, blocked, waiting, or offline. Add:

```ts
type AgentActivity = 'starting' | 'thinking' | 'typing' | 'using_tool' | 'waiting' | 'idle' | 'error';

type ObservabilityFidelity = 'exact' | 'inferred';
type ObservabilitySource = 'ai-sdk' | 'pty-structured' | 'pty-terminal' | 'broker';

type ObservabilitySupport =
  | { available: true; fidelities: readonly ObservabilityFidelity[] }
  | { available: false };
```

Relaycast publishes `agent.activity.changed` with agent id, current and previous activity, reason, turn id, sequence, timestamp, source, fidelity, and optional tool/approval details. `waiting` always includes a reason such as `tool_approval`, `turn_suspended`, or `external_dependency`.

The canonical semantic vocabulary covers:

- session starting, started, resumed, suspended, detached, stopped, destroyed, and failed;
- turn started, step finished, and turn finished with finish reason;
- text and reasoning blocks;
- tool called, approval requested/resolved, completed, and failed;
- file created, modified, and deleted;
- context compaction;
- model resolution, warnings, usage, diagnostics, and errors.

Every runtime declares `AgentObservabilityCapabilities`, with supported fidelities or `available: false` for each semantic family and activity. Event metadata carries the actual source and fidelity used for that event, allowing a runtime to provide both exact and inferred forms of one activity.

The shared activity reducer tracks active text ids, reasoning ids, unresolved tool calls, pending approvals, turn state, and startup state. Its precedence is:

```text
error > waiting > using_tool > typing > thinking > starting > idle
```

Only explicit dependencies produce `waiting`; silence alone preserves the current activity. `finish-step` preserves an active turn. Turn-level `finish` followed by settled prompt control produces `idle`.

The AI SDK mapping is the reference profile:

| Activity     | Reference signal                                         | Fidelity           |
| ------------ | -------------------------------------------------------- | ------------------ |
| `starting`   | sandbox/bootstrap/`doStart()` begins                     | exact, broker/host |
| `thinking`   | `reasoning-start`/`reasoning-delta`                      | exact              |
| `thinking`   | prompt accepted before the first content event           | inferred           |
| `typing`     | `text-start` through matching `text-end`                 | exact              |
| `using_tool` | `tool-call` through matching `tool-result`               | exact              |
| `waiting`    | `tool-approval-request` or suspended external dependency | exact              |
| `idle`       | turn `finish` and prompt-control `done` settle           | exact              |
| `error`      | stream error, rejected turn/start, or runtime failure    | exact              |

PTY translators target the same profile in priority order: structured CLI/event output first, stable terminal markers second, broker lifecycle signals third. The capability profile exposes remaining gaps without inventing precision.

## Current state

### Relay

- Root `package.json` and `packages/cli/package.json` require Node `>=20.9.0`.
- CI workflows contain explicit Node 20 jobs.
- `packages/harnesses/src/index.ts` exports PTY-backed Claude, Codex, Gemini, Cursor, Droid, OpenCode, Aider, Goose, and Grok harnesses.
- `packages/harnesses/src/define.ts:68-91` routes built-ins through `BrokerDriver.spawn({ transport: 'pty' })`.
- `packages/sdk/src/session/types.ts:278-287` defines the `AgentSession` contract.
- `packages/sdk/src/delivery/runner.ts:91-129` owns durable delivery and ack/fail/defer transitions.
- `packages/sdk/src/session/types.ts:4` currently models durable status as `active | idle | blocked | waiting | offline`; it has no separate high-frequency activity type.
- Existing session events already cover status, tools, transcript chunks, file changes, usage, session lifecycle, logs, and errors, but not the full AI SDK turn, reasoning, approval, compaction, model, and fidelity vocabulary.
- Relaycast currently publishes `agent.status.*` for durable session status. It needs a first-class activity event for UI-facing `starting`, `thinking`, `typing`, `using_tool`, `waiting`, `idle`, and `error` transitions.
- CLI attach consumes PTY `worker_stream` bytes and currently returns `no_pty` for headless workers.

### AI SDK harness contract

The package-family baseline for this plan is:

| Package                       | Version  | Node engine |
| ----------------------------- | -------- | ----------- |
| `@ai-sdk/harness`             | `1.0.34` | `>=22`      |
| `@ai-sdk/harness-claude-code` | `1.0.35` | `>=22`      |
| `@ai-sdk/harness-codex`       | `1.0.36` | `>=22`      |
| `@ai-sdk/harness-opencode`    | `1.0.35` | `>=22`      |
| `@ai-sdk/harness-pi`          | `1.0.34` | `>=22`      |
| `@ai-sdk/harness-deepagents`  | `1.0.33` | `>=22`      |

Confirm the current coherent published family before installation and pin exact versions.

`HarnessV1Session.doPromptTurn()` returns `HarnessV1PromptControl`, including optional active input:

```ts
submitUserMessage?(text: string): PromiseLike<void>;
```

Claude Code, Codex, OpenCode, Pi, and Deep Agents implement active input in these baseline versions.

Bridge-backed adapters require `HarnessV1NetworkSandboxSession` with a reachable port. Pi is host-resident. The Relay local-host provider supplies a consistent filesystem and process lifecycle to both forms.

Deep Agents currently supports active messages, live detach/attach, suspend/continue, and approval responses. Its stopped-session state does not preserve in-memory conversation, and manual compaction is unavailable. Its public Relay capabilities must reflect the installed adapter's contract-test results.

## Scope

### In scope

- Node 22 engine declarations, CI jobs, runtime guards, and installation docs.
- Exact AI SDK harness dependencies and lockfile updates.
- `packages/harnesses/src/ai-sdk/`:
  - `adapter-registry.ts`
  - `local-host-sandbox.ts`
  - `harness-host.ts`
  - `relay-session.ts`
  - `sidecar.ts`
  - adjacent tests
- `packages/harnesses/src/define.ts` and `packages/harnesses/src/index.ts`.
- Semantic protocol and client additions in `packages/harness-driver`.
- Canonical observability types, activity reducer, capability profile, listeners, and tests in `packages/sdk`.
- Broker supervision, runtime metadata, semantic event replay, and input endpoints.
- Relaycast wire support for canonical activity and semantic session events.
- Semantic attach routing, rendering, and input in `packages/cli`.
- PTY observability translators and capability declarations for existing harnesses.
- Contract and soak tests under `tests/integration/ai-sdk-harnesses/`.
- Harness documentation, root runtime documentation, `CHANGELOG.md`, and `plans/README.md`.

### Stable boundaries

- `DeliveryRunner` remains the durable delivery authority.
- Agent identity, channels, threads, retry queues, and dead-letter behavior retain their existing public contracts.
- The PTY runtime remains intact.
- Hosted sandbox infrastructure is not required for local adapter execution.
- AI SDK model-provider packages are outside this harness-adapter plan.

## Git workflow

- Branch: `codex/ai-sdk-harness-adoption`.
- Use conventional commits grouped by logical stage, such as `chore: require Node 22`, `feat(harnesses): add AI SDK runtime`, and `test(harnesses): add adapter contracts`.
- Work remains on the feature branch. The operator decides when to push, open a PR, and merge.

## Commands

| Purpose            | Command                                                                                                                  | Expected result                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Install            | `npm install`                                                                                                            | exit 0 with intentional lockfile changes                    |
| Typecheck          | `npm run typecheck`                                                                                                      | exit 0                                                      |
| Focused build      | `npm run build:sdk && npm run build:harness-driver && npm run build:harnesses && npm run build:cli`                      | exit 0                                                      |
| Focused tests      | `npx vitest run packages/harnesses packages/harness-driver packages/sdk packages/cli tests/integration/ai-sdk-harnesses` | deterministic suites pass                                   |
| Full tests         | `npm test`                                                                                                               | exit 0 on Node 22                                           |
| Lint and format    | `npm run lint && npm run format:check`                                                                                   | exit 0                                                      |
| Broker tests       | `cargo test --manifest-path crates/broker/Cargo.toml`                                                                    | exit 0                                                      |
| Node baseline scan | `rg -n -e 'Node 20' -e 'node-version:.*20' -e '"node": ">=20' package.json packages .github README.md`                   | no supported-runtime references remain                      |
| Real adapter tests | `RELAY_INTEGRATION_REAL_CLI=1 npx vitest run tests/integration/ai-sdk-harnesses`                                         | configured adapters pass; unavailable adapters skip by name |

## Steps

### Step 1: Move Relay to Node 22 and install the adapter family

Update root and published CLI engine declarations to Node `>=22.0.0`. Update every Node 20 CI job to Node `22.14.0` while preserving each job's purpose and platform coverage. Add an early CLI runtime error if the package engine alone does not produce a clear failure.

Update runtime documentation and fixtures. Raise the pending changelog to `[Unreleased - Major]` and add Node 22 under `Breaking Changes` and `Migration Guidance`.

Add the six exact AI SDK harness packages from the confirmed coherent release family to `packages/harnesses/package.json` and update the lockfile.

**Verify**:

```bash
npm install
npm ls @ai-sdk/harness @ai-sdk/harness-claude-code @ai-sdk/harness-codex @ai-sdk/harness-opencode @ai-sdk/harness-pi @ai-sdk/harness-deepagents
rg -n 'Node 20|node-version:.*20|"node": ">=20' package.json packages .github README.md
npm run typecheck
```

Expected: one exact version of each adapter package is installed, the scan finds no supported Node 20 baseline, and typecheck passes.

### Step 2: Add the adapter registry and local-host sandbox

Create `adapter-registry.ts`. Each entry declares:

- Relay harness name and aliases;
- package factory;
- Relay-to-adapter settings mapper;
- bridge-backed or host-resident execution;
- declared lifecycle capabilities;
- PTY availability;
- rollout state: `experimental`, `validated`, or `default`.

Register Claude Code, Codex, OpenCode, Pi, and Deep Agents.

Create `local-host-sandbox.ts` implementing `HarnessV1SandboxProvider` and `HarnessV1NetworkSandboxSession` over an explicit absolute workspace. It provides:

- the restricted file/run/spawn surface required by the adapter contract;
- one exclusive loopback bridge port per bridge-backed session;
- owned-process tracking with graceful then forced cleanup;
- abort propagation;
- idempotent bootstrap recipes cached by stable identity;
- preflight checks for Node, `pnpm`, workspace access, ports, and cache state;
- deletion limited to runtime-owned cache and state.

Document the provider as local process execution and lifecycle ownership rather than filesystem isolation. Path validation is best-effort protection against accidental lexical and static symlink escapes; it is not a TOCTOU-safe boundary against concurrent filesystem mutation.

**Verify**:

```bash
npx vitest run packages/harnesses/src/ai-sdk/adapter-registry.test.ts packages/harnesses/src/ai-sdk/local-host-sandbox.test.ts
npm run build:harnesses
```

Expected: all five registry entries pass; sandbox tests cover file/process operations, abort, concurrency, exclusive ports, bootstrap caching, cleanup, and preservation of workspace files.

### Step 3: Define Relay's canonical observability contract

Extend `packages/sdk/src/session/types.ts` with `AgentActivity`, observability source/fidelity, `AgentObservabilityCapabilities`, and the canonical semantic event families listed above. Preserve `AgentSessionStatus` for durable presence and health.

Add a pure activity reducer in the session layer. It consumes canonical semantic events and emits deduplicated `activity.changed` transitions. Track block and call ids as sets/maps so parallel tools and interleaved reasoning/text produce stable activity. Include reason, turn id, sequence, timestamp, source, fidelity, and optional tool/approval context.

Extend Relay listeners and Relaycast with:

- `agent.activity.changed` as the public activity transition;
- canonical session events under the existing session-event envelope;
- capability discovery so consumers can inspect the runtime's exact/inferred/unavailable matrix.

Create AI SDK reference fixtures covering every `HarnessV1StreamPart` variant and the full activity transition sequence. The reference fixture defines the observability target used by all runtime contract reports.

**Verify**:

```bash
npx vitest run packages/sdk/src/session packages/sdk/src/__tests__/listeners.test.ts
cargo test --manifest-path crates/broker/Cargo.toml relaycast
npm run build:sdk
```

Expected: public event typing, reducer precedence, parallel blocks/tools, approval waiting, step versus turn completion, fidelity metadata, capability discovery, and Relaycast wire round-trips pass.

### Step 4: Host `HarnessV1` and implement `AgentSession`

Create `harness-host.ts` around the public low-level contract:

1. Apply bootstrap through the local-host provider.
2. Create a stable session id and workspace.
3. Start the adapter with permission mode, skills, diagnostics, abort signal, and validated resume state.
4. Start turns with `doPromptTurn()` and retain the returned control until `done` settles.
5. Route active input through `submitUserMessage()` when supported.
6. Normalize `HarnessV1StreamPart` into Relay semantic events.
7. Serialize turn and lifecycle transitions.
8. Surface supported detach, stop, destroy, resume, suspend, continue, and approval operations through capability-accurate results.

Use a turn generation token so completion from an older turn cannot clear a newer active control.

Create `relay-session.ts` implementing the existing `AgentSession` contract:

- idle input starts one prompt turn;
- active `immediate` and `next-tool-call` input uses the retained control;
- `next-message` and `on-idle` input enters a bounded FIFO and starts after the active turn;
- receives are serialized and deduplicated by Relay idempotency/message id;
- queue overflow fails the newest message explicitly;
- adapter acceptance maps to `accepted`, while end-to-end model consumption remains observable rather than assumed;
- `DeliveryRunner` remains responsible for durable ack/fail/defer transitions.

Map every shared harness event into the canonical Relay vocabulary. Feed those events through the shared activity reducer rather than maintaining AI-SDK-specific status logic. Preserve adapter metadata as optional enrichment while source and fidelity remain portable.

**Verify**:

```bash
npx vitest run packages/harnesses/src/ai-sdk/harness-host.test.ts packages/harnesses/src/ai-sdk/relay-session.test.ts packages/sdk/src/__tests__/delivery-actions.test.ts
npm run build:sdk
npm run build:harnesses
```

Expected: prompt flow, active injection, FIFO ordering, deduplication, stale-turn protection, lifecycle races, capability errors, and receipt semantics pass.

### Step 5: Add the broker-supervised semantic sidecar

Create `sidecar.ts` and a framed, versioned protocol shared with `packages/harness-driver`. The protocol carries:

- lifecycle commands and correlated acknowledgements;
- normalized semantic events with per-agent sequence numbers;
- activity transitions and runtime observability capabilities;
- idle-turn input and active-turn `submit_user_message` input with idempotency keys;
- interrupt, approval, release, and capability responses;
- diagnostics on a channel separate from transcript events.

The broker:

- supervises the Node 22 sidecar as a headless worker;
- publishes `semantic-harness` runtime and capability metadata;
- retains bounded semantic history with a high-water sequence number;
- broadcasts live events;
- exposes authenticated history and semantic input endpoints;
- reconciles subscribe-first live events with fetched history;
- terminates owned sidecars on release and marks protocol failure explicitly.

**Verify**:

```bash
npx vitest run packages/harness-driver packages/harnesses/src/ai-sdk/sidecar.test.ts
cargo test --manifest-path crates/broker/Cargo.toml
```

Expected: version negotiation, correlation, ordering, replay bounds, history/live reconciliation, input acknowledgement, idempotency, authorization, crash handling, and cleanup pass.

### Step 6: Add semantic CLI attach

Route `agent attach` by runtime metadata:

- PTY agents retain existing `view`, `drive`, and `passthrough` behavior.
- Semantic harness agents use the new semantic renderer.

Semantic `view` is read-only. Semantic `drive` accepts line-oriented messages: idle input starts a turn and active input uses the retained prompt control. Semantic `passthrough` returns a clear unsupported-mode error because there is no terminal byte stream.

Human output renders:

- current activity and explicit waiting reason;
- assistant text;
- compact tool start, finish, and error activity;
- file changes and approvals;
- lifecycle status, usage, and errors.

Reasoning and diagnostics are opt-in. `--json` emits normalized NDJSON with no decorative stdout. The CLI waits for broker acknowledgement before reporting input acceptance and defines explicit detach and interrupt controls.

**Verify**:

```bash
npx vitest run packages/cli/src/cli/lib/attach-semantic.test.ts packages/cli/src/cli/commands/local-agent.test.ts
npm run build:cli
```

Expected: replay plus live events render once in order; human mode contains no protocol JSON; NDJSON is valid; input, rejection, detach, interrupt, and passthrough behavior pass.

### Step 7: Wire backend selection and observability profiles

Add `backend` selection to harness creation and route registered adapters through the sidecar runtime.

- Claude Code, Codex, and OpenCode begin as `experimental`, leaving PTY as their `auto` selection during validation.
- Pi is exported as an experimental AI SDK-only harness.
- Deep Agents is exported as an experimental AI SDK-only harness with its tested capability subset.
- Unsupported harnesses continue through PTY.

Add an observability profile to every AI SDK and PTY registry entry. AI SDK entries target the complete reference profile. PTY entries declare a baseline from broker lifecycle signals and add structured or inferred signals available from that CLI.

Build PTY translators behind the same canonical event interface. Prefer structured JSON/event modes exposed by the CLI. Use stable terminal markers for remaining activity and label those events `pty-terminal` plus `inferred`. At minimum, every PTY harness reports exact broker-owned `starting` and runtime failure, its best supported idle/busy boundary, and an honest capability matrix for reasoning, text, tools, approvals, files, compaction, usage, and lifecycle.

After an adapter passes Step 8, update only that registry entry's rollout state. `default` makes `auto` select AI SDK; `backend: 'pty'` remains the terminal-runtime override for shared harnesses.

**Verify**:

```bash
npx vitest run packages/harnesses/src/define-spawn.test.ts packages/harnesses/src/ai-sdk
npm run typecheck
```

Expected: all runtime-selection branches, aliases, unavailable adapters, public exports, observability declarations, and PTY provenance/fidelity mappings pass.

### Step 8: Run adapter contracts and promotion soaks

Create one deterministic contract suite under `tests/integration/ai-sdk-harnesses/` and run it against every registry entry using fake adapters in CI.

Common contract:

1. Cold and warm create.
2. First and subsequent turns.
3. Idle input starts one turn.
4. Active input is accepted once.
5. Duplicate ids never inject twice.
6. Concurrent input preserves order.
7. Crash and release clean up owned processes without acknowledging unaccepted work.
8. Capability declarations match method outcomes.
9. Semantic replay and attach remain ordered.
10. PTY regressions pass for shared harnesses.
11. Every emitted event matches the canonical schema and declared fidelity.
12. Activity transitions match the reference reducer, including parallel tools and approvals.
13. Runtime capability profiles match observed events and list unavailable signals explicitly.

Claude Code, Codex, OpenCode, and Pi additionally cover detach/resume, stop/resume, and suspend/continue wherever declared. Deep Agents covers its reduced lifecycle contract, including conversation-lossy stopped sessions and unavailable manual compaction.

Run real adapters behind `RELAY_INTEGRATION_REAL_CLI=1`; unavailable local CLIs or credentials skip by adapter name.

Before promotion, run at least 100 isolated create/task/release cycles per adapter across macOS and Linux. Record create rate, time to ready, turn completion, injection acceptance, duplicate count, lifecycle success, cleanup, warm-start performance, typed failures, activity transition accuracy, and observability completeness.

Promotion requires:

- zero duplicate injections;
- zero accepted inputs lost before adapter control;
- zero orphaned owned processes;
- at least 99% create success excluding explicit auth or provider outages;
- at least 99% success for every advertised lifecycle capability;
- warm p95 time to ready within 25% of PTY for shared harnesses;
- actionable typed failures.
- complete exact coverage of the AI SDK reference profile for every signal the installed adapter emits.

Promote each adapter independently by changing its registry state. Deep Agents remains experimental while its stopped-session continuity and compaction limits remain.

**Verify**:

```bash
npx vitest run packages/harnesses tests/integration/ai-sdk-harnesses
RELAY_INTEGRATION_REAL_CLI=1 npx vitest run tests/integration/ai-sdk-harnesses
npm test
cargo test --manifest-path crates/broker/Cargo.toml
```

Expected: deterministic tests pass, configured real adapters pass their declared contract, unavailable adapters report named skips, and the soak command produces a machine-readable promotion and observability report. The report compares each PTY profile with the AI SDK reference by semantic family and fidelity rather than collapsing gaps into one score.

### Step 9: Document and release the runtime change

Update harness and root documentation with:

- Node 22 requirement;
- support matrix and backend selection;
- semantic `view`, `drive`, `--json`, reasoning, and diagnostics behavior;
- canonical activities, semantic event families, capability discovery, source, and fidelity;
- the AI SDK reference profile and per-PTY-runtime observability matrix;
- Pi and Deep Agents examples;
- Deep Agents lifecycle limits;
- local-host runtime security model;
- bootstrap/cache and `pnpm` preflight troubleshooting;
- exact adapter package versions and update procedure.

Add an impact-first changelog entry under `[Unreleased - Major]`:

- `Breaking Changes`: Relay requires Node 22.
- `Migration Guidance`: upgrade Node before installing the new Relay version.
- `Added`: AI SDK-backed Claude Code, Codex, OpenCode, Pi, and experimental Deep Agents runtimes, with PTY retained for terminal and unsupported harnesses.
- `Added`: Relaycast agent activity and semantic observability events with runtime capability and fidelity metadata.

**Verify**:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
cargo test --manifest-path crates/broker/Cargo.toml
git diff --check
git status --short
```

Expected: all commands pass; modified files are in scope plus project-required trajectory records.

## Test plan

### Runtime baseline and registry

- Node 22 package engines, runtime guard, CI matrix, exact dependencies, registry aliases, settings, lifecycle/observability capabilities, PTY availability, and rollout state.

### Canonical observability

- Public activity and semantic event types, reducer precedence, parallel block/tool tracking, explicit waiting reasons, source/fidelity, capability discovery, Relaycast transport, and AI SDK reference fixtures.

### Local-host provider

- File/run/spawn behavior, abort, exclusive loopback ports, concurrent sessions, bootstrap cache, failed start, owned-process cleanup, and preservation of workspace files.

### Harness host and Relay delivery

- Prompt turns, active input, stream mapping, accepted/deferred receipts, FIFO ordering, deduplication, queue bounds, lifecycle capabilities, release, abort, and resume races.

### Broker and attach

- Protocol versioning, correlation, semantic history, activity transitions, capability profiles, live reconciliation, authentication, acknowledged input, crash cleanup, human rendering, NDJSON, reasoning/diagnostics flags, and PTY regressions.

### Adapter contracts

- Full declared contract for Claude Code, Codex, OpenCode, and Pi.
- Reduced contract for Deep Agents.
- AI SDK reference observability coverage and PTY exact/inferred/unavailable parity reports.
- Isolated real-adapter promotion soaks.

## Done criteria

- [ ] Relay packages, CLI, CI, and docs require Node 22.
- [ ] Exact official AI SDK harness packages are installed as one tested family.
- [ ] The adapter registry contains Claude Code, Codex, OpenCode, Pi, and Deep Agents with tested capabilities and rollout states.
- [ ] Relay defines a runtime-neutral semantic event vocabulary and `starting | thinking | typing | using_tool | waiting | idle | error` activity reducer.
- [ ] Relaycast publishes activity transitions, semantic session events, and observability capability discovery with source and fidelity.
- [ ] AI SDK adapters satisfy the reference observability profile from structured HarnessV1 events.
- [ ] Every PTY harness declares exact, inferred, or unavailable support for each reference signal and emits available signals through the same contract.
- [ ] The local-host provider owns adapter processes, bootstrap cache, workspace access, and loopback bridge ports.
- [ ] The HarnessV1 host retains active prompt control and implements lifecycle operations accurately.
- [ ] `AgentSession` preserves Relay delivery ordering, deduplication, durability boundaries, and truthful receipts.
- [ ] The broker supervises semantic sidecars and provides authenticated replay, live events, and acknowledged input.
- [ ] Semantic `view` and `drive` work; `--json` produces NDJSON; PTY attach behavior remains compatible.
- [ ] Unsupported harnesses use PTY, and shared harnesses retain explicit PTY selection.
- [ ] Each default adapter has passed deterministic contracts and its promotion soak.
- [ ] Deep Agents exposes only its tested lifecycle subset.
- [ ] Full typecheck, test, lint, format, and broker suites pass.
- [ ] `[Unreleased - Major]` contains the Node 22 break and AI SDK runtime addition.
- [ ] `plans/README.md` is updated.

## STOP conditions

Stop and report if:

- The installed `HarnessV1` contract does not return prompt control with active user-message support for a target adapter.
- The published adapter versions cannot be installed as a coherent Node 22 family.
- The local-host provider cannot keep bridge ports loopback-only or clean up only processes it owns.
- Delivery integration would bypass `DeliveryRunner` or introduce another durable queue.
- Semantic history and live events cannot be reconciled without gaps or duplicates.
- The public event contract cannot distinguish structured events from terminal inference or cannot expose unsupported signals explicitly.
- An adapter requires provider-specific parsing outside the shared `HarnessV1StreamPart` vocabulary.
- A verification command fails twice after a scoped repair.

## Maintenance notes

- Update the harness package family through the full contract suite and real-adapter pilots.
- Add future official adapters through one registry entry, settings mapper, capability declaration, and contract case.
- Treat the AI SDK reference profile as Relay's observability benchmark. Review every runtime against the same semantic-family matrix.
- Improve PTY fidelity through structured CLI modes first and terminal inference second; preserve source/fidelity on every event.
- Keep support status and default-runtime status separate in public documentation.
- Preserve PTY as the terminal runtime and rollback path for shared harnesses.
- Re-run Deep Agents capability tests before advertising stopped-session continuity or compaction.
- Review receipt timing, duplicate prevention, process ownership, loopback exposure, replay ordering, bootstrap identity, and lifecycle capability accuracy on every adapter update.
