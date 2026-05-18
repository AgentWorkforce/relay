# Trajectory: Upgrade .agentworkforce personas to latest 3.x shape

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 14, 2026 at 02:28 PM
> **Completed:** May 18, 2026 at 06:06 PM

---

## Summary

Refactored runDriveSession (complexity 23 → under 15) by extracting prepareDriveAttachTarget, switchWorkerToManualFlush, captureSnapshotForDrive, syncInitialPtySize, pickInitialTerminalRows, and runDriveSessionLoop. All 387 CLI tests still pass; ESLint warning resolved. Public API surface and exports unchanged so passthrough.ts and tests still work.

**Approach:** Standard approach

---

## Key Decisions

### Factored broker-connection discovery into src/cli/lib/broker-connection.ts
- **Chose:** Factored broker-connection discovery into src/cli/lib/broker-connection.ts
- **Reasoning:** Drive and view both need the same flag/env/connection.json fallback chain; pulling it out keeps both verbs aligned and unblocks future relay/new/run verbs from sub-PR 4.

### Hand-rolled keybind state machine in drive.ts instead of pulling in readline.emitKeypressEvents
- **Chose:** Hand-rolled keybind state machine in drive.ts instead of pulling in readline.emitKeypressEvents
- **Reasoning:** All bindings are ASCII control chars (Ctrl+G/Ctrl+C/Ctrl+B prefix). Tiny stateful parser handles cross-chunk Ctrl+B prefix cleanly and is trivially testable.

### Overload existing 'run' command rather than registering a second one — Commander only allows one verb per name and there's already a workflow-runner 'run <file>'
- **Chose:** Overload existing 'run' command rather than registering a second one — Commander only allows one verb per name and there's already a workflow-runner 'run <file>'
- **Reasoning:** Adds -n/--mode/--ephemeral flags and dispatches to spawn-and-attach when -n is set, otherwise falls through to the existing workflow runner. Preserves backward compatibility for all existing 'run <file>' invocations.

### relay copies-and-trims drive rather than sharing a base class
- **Chose:** relay copies-and-trims drive rather than sharing a base class
- **Reasoning:** Trimmed surface (no queue UI, no Ctrl+G, no delivery_queued/agent_pending_drained tracking) is small enough that an abstraction layer would cost more clarity than it saves. drive.ts is documented as canonical; relay.ts header comment points there. If a third sibling lands, factor.

### Silent -n alias dispatched via argv pre-parser before commander runs, not via a hidden internal verb
- **Chose:** Silent -n alias dispatched via argv pre-parser before commander runs, not via a hidden internal verb
- **Reasoning:** Pre-parser (parseVerblessAlias) catches the four canonical shapes (-n NAME, --name NAME, -nNAME, --name=NAME), refuses ambiguous (-n NAME <known-verb>) and help/version, then hands off to runSpawnAndAttach with mode='relay' and ephemeral=true. Single code path with run -n NAME CLI guarantees byte-equivalence; bootstrap.test.ts asserts the triplet extraction matches what commander's run -n action sees.

### Drop the 'run' verb, fold spawn-and-attach into 'new --attach'
- **Chose:** Drop the 'run' verb, fold spawn-and-attach into 'new --attach'
- **Reasoning:** Reviewer pushback: the _actionHandler.apply() hack to overload commander's run was a code smell signaling the verb naming was wrong. Moving the composition to 'new --attach' eliminates the workflow-runner name conflict cleanly, keeps the verb taxonomy simple (new spawns, view/drive/relay sessions), and the alias retargets transparently — both -n alias and new --attach call the same runSpawnAndAttach helper, byte-equivalence preserved.

### Refactor runDriveSession by extracting prep helpers + session loop
- **Chose:** Refactor runDriveSession by extracting prep helpers + session loop
- **Reasoning:** ESLint complexity 23 > 15. Splitting validate target, mode switch, snapshot handling, PTY size sync, and the Promise-based session runner into helpers preserves behavior, reduces parent complexity to under 15, keeps all public exports stable for tests and passthrough.ts

---

## Chapters

### 1. Work
*Agent: default*

- Factored broker-connection discovery into src/cli/lib/broker-connection.ts
- Hand-rolled keybind state machine in drive.ts instead of pulling in readline.emitKeypressEvents
- Overload existing 'run' command rather than registering a second one — Commander only allows one verb per name and there's already a workflow-runner 'run <file>': Overload existing 'run' command rather than registering a second one — Commander only allows one verb per name and there's already a workflow-runner 'run <file>'
- relay copies-and-trims drive rather than sharing a base class: relay copies-and-trims drive rather than sharing a base class
- Silent -n alias dispatched via argv pre-parser before commander runs, not via a hidden internal verb: Silent -n alias dispatched via argv pre-parser before commander runs, not via a hidden internal verb
- Drop the 'run' verb, fold spawn-and-attach into 'new --attach': Drop the 'run' verb, fold spawn-and-attach into 'new --attach'
- Refactor runDriveSession by extracting prep helpers + session loop: Refactor runDriveSession by extracting prep helpers + session loop

---

## Artifacts

**Commits:** e8502cb, 850c8e0, de77083, 88b12e6, da9e912, 37c314f, 355bc07, 45b7c15, cd72e61, 106b7d9, e3ac4fc, 79bbfdd, 3356ecd, 2c59e77, 80c0d6e, 2c6abac, 35ef0a8, 0a44e6f, b9e421a, 0d61a4e, 35a331c, 403cd00, 765156f, a0ef506, 592b0e6, c10a9d5, 209e5d4, 5fef86b, efcb1ed, 0aeb71c, 47a77c8, b73642e, 09240e3, 18ccff3, a1c0d06, b89d874, 689eed0, 1bd6e48, 38abde4, 789ec19, c48e884, e854f91, 9ae5eb8, 2f32141, e2834ca, df45489, 52319ff, 7295f1a, f31b91b, 703843f, 6326d18, 3a76225, a30e5c8, 885df69, 40b8443, 3e1e61a, 687160a, 51c9372, 71358b1, 1f01c87, c95a609, 82a3883, 5fc8a13, 8de35af, 5a652d6, 5bcca47, b04bc64, 6e0b7bc, 48704de, 18852c4, 2b69c44, 9cee216, 3ed3530, 3896309, 52571b3, 3d33cb5, d771a6e, cc491e3, 0b0518a, 89c2c36, 9283abc, 4a4c05a, 43389b0, d3f02ce, 633aa2a, 56f3565, 34765f5, 88db665, 881ae7a, ae04694, cbe2934, 208b425, cbc70b0, bf993f2, 759d351, a7ef2fc, 34cd340, 9de8d53, a8a3e0b, 195f55f, e033054
**Files changed:** 187
