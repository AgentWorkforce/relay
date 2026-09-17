# Trajectory: Implement and prove all nine GitHub subscription demo gates

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** September 8, 2026 at 03:53 AM
> **Completed:** September 17, 2026 at 03:01 PM

---

## Summary

agent-relay now mounts relayfile, relayflows, and relayhistory as file/flows/sessions via a shared @agent-relay/cli-surface contract; four product repos export mountable surfaces; v1 relayflows deprecated where genuinely v1; reflex command removed

**Approach:** Standard approach

---

## Key Decisions

### Require live harness readiness before subscriptions; use identity-bound channels and atomic mailbox backpressure
- **Chose:** Require live harness readiness before subscriptions; use identity-bound channels and atomic mailbox backpressure
- **Reasoning:** Registry presence and channel arrival cannot prove an agent can act. Keep unique events retryable, preserve exact recipient identity and require correlated GitHub-to-actor evidence.

### Keep readiness fail-closed and restrict identity deletion to owned generation-authorized cleanup
- **Chose:** Keep readiness fail-closed and restrict identity deletion to owned generation-authorized cleanup
- **Reasoning:** Independent Claude review exposed empty-channel defaulting, absent-generation cleanup and raw-hook overflow gaps. Repaired them, added actual D1 concurrent overflow/retry and real command startup cleanup proofs. Unverified acknowledgements and undeployed source do not satisfy the nine live gates.

### Require create-only identity ownership and acknowledged fleet deregistration before failed-spawn deletion
- **Chose:** Require create-only identity ownership and acknowledged fleet deregistration before failed-spawn deletion
- **Reasoning:** Round2 review exposed cached identity provenance and enqueue-versus-completion races; fail closed on older brokers lacking empty-channel confirmation.

### Round3 live process tests exposed cached isolation, retired identity cleanup and inventory falsely completing verified spawns; fixed contracts and captured red/green regressions
- **Chose:** Round3 live process tests exposed cached isolation, retired identity cleanup and inventory falsely completing verified spawns; fixed contracts and captured red/green regressions
- **Reasoning:** Live DB membership and delayed process exit revealed gaps hidden by successful request echoes and immediate-exit mocks. Production capacity boundary remains preserved.

### Require stable Claude trust selection and explicit proof-worker tool restrictions
- **Chose:** Require stable Claude trust selection and explicit proof-worker tool restrictions
- **Reasoning:** Real Claude tests exposed a transient Yes-to-No repaint and receiver inbox polling despite its task. A delayed-reset regression fails before the stable-grid repair. The proof worker disables history tools and uses the recorded zero-delay input setting; two synthetic pushed events now have correlated actor digest replies. Real GitHub and chief evidence remain pending.

### Wait for delegated broker readiness in served fleet actions
- **Chose:** Wait for delegated broker readiness in served fleet actions
- **Reasoning:** The native fleet matrix exposed placement-only false success hiding rejected launches. Keep SDK placement semantics and add a bounded served-provider wait using least-privilege node-owned invocation reads; use a genuine Codex-shaped native resume fixture and confirm both launch and release.

### Mounted product CLIs via a shared RelayCliSurface contract instead of vendoring commands
- **Chose:** Mounted product CLIs via a shared RelayCliSurface contract instead of vendoring commands
- **Reasoning:** Each product repo exports a spec+dispatcher; relay owns one generic mounter. Argv forwards verbatim because relay cannot re-serialize flags it has never heard of, and help renders from the spec so a mounted product prints 'agent-relay file ls' rather than its own program name.

### Scoped the v1 relayflows deprecation to what is actually v1
- **Chose:** Scoped the v1 relayflows deprecation to what is actually v1
- **Reasoning:** Only cloud schedule/schedules reject --relayflow-version v2. status/logs/sync/cancel take a run id and serve either engine, so deprecating them would have told v2 users their run-management commands were going away. node workflow run|logs|sync are genuinely v1 (pinned to @relayflows/cli 1.0.1) and were deprecated instead.

---

## Chapters

### 1. Work
*Agent: default*

- Require live harness readiness before subscriptions; use identity-bound channels and atomic mailbox backpressure: Require live harness readiness before subscriptions; use identity-bound channels and atomic mailbox backpressure
- Keep readiness fail-closed and restrict identity deletion to owned generation-authorized cleanup: Keep readiness fail-closed and restrict identity deletion to owned generation-authorized cleanup
- Require create-only identity ownership and acknowledged fleet deregistration before failed-spawn deletion: Require create-only identity ownership and acknowledged fleet deregistration before failed-spawn deletion
- Round3 live process tests exposed cached isolation, retired identity cleanup and inventory falsely completing verified spawns; fixed contracts and captured red/green regressions: Round3 live process tests exposed cached isolation, retired identity cleanup and inventory falsely completing verified spawns; fixed contracts and captured red/green regressions
- Require stable Claude trust selection and explicit proof-worker tool restrictions: Require stable Claude trust selection and explicit proof-worker tool restrictions
- Synthetic Claude push proof passed two idle actions, ten-minute idle, ten unique burst events and a real node reconnect. Source and deployed readiness remain separate; engine bot races are repaired and final review is pending.
- Review4 repairs now pass 1343 Rust tests and full JavaScript validation plus nine optional Bun cases. Owned cleanup no longer waits on remote ACKs inside the runtime; a parent-behavior red control proves the old stall. Token hashes and generations remain guarded through retries. Native startup rehearsal passes fifteen checks. Committed portable ten-minute proof and fresh review5 remain pending; all intended-environment gates still require coordinated release and capacity clearance.
- Wait for delegated broker readiness in served fleet actions: Wait for delegated broker readiness in served fleet actions
- Mounted product CLIs via a shared RelayCliSurface contract instead of vendoring commands: Mounted product CLIs via a shared RelayCliSurface contract instead of vendoring commands
- Scoped the v1 relayflows deprecation to what is actually v1: Scoped the v1 relayflows deprecation to what is actually v1

---

## Artifacts

**Commits:** ca620892e, ff094de85, 3fd3ec1aa, 925a87fce, a21ca0181, e24ac6cf1, 4340084e6, 00c5b9d38, b1a3777e0, 70748ab89, d399f8650, f0c5dc1f0, 2c3c25f2e, f58f453ec, 2cae85387, 6767d40e3, 8598e912c, 944379d88, 9d343c950, fe60e1fdc, 67b598f85, 24d70f384, e55bec491, 48d650cf5, 1259edf83, df3e0b2bc, 2e380a3db, a916d0ae3, 75cf85176, ec6cac40f, f69a84a8d, 120ad71fa, 08d6bf353, 2a48075c5, fa14d5eb7, 9ad847166, ad137a7e2, 6e44912d9, 39ca68f5d, b90248a39, 358a2c2c5, e404d2fd5, bd3c20f36, 4306bb29b
**Files changed:** 352
