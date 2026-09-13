# Trajectory: Implement and prove all nine GitHub subscription demo gates

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** September 8, 2026 at 12:53 PM
> **Completed:** September 13, 2026 at 07:04 PM

---

## Summary

Added deterministic Cursor MCP cleanup interleaving regression and preserved retryable lease behavior

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

---

## Artifacts

**Commits:** 0950ad645, 1aa59dbab, 433914719, 731629089, f138efeee, 911e367ed, 665ec0ba1, 821c54be5, 9f95fd612, df3e0b2bc, a958fe44c, 0f7a38550, 2e380a3db, a916d0ae3, c25ba3b04, 5f901a7e6, 192d770e9, 8164b7650, a23ede0ce, 75cf85176, c35a89bbe, a42c00dec, c4c11c722, 70e930e68, 9d176c20b, 807fe0eb7, cb9bc1a0d, 58c97267e, d3d50da3a, 78aea8f09, 30613aa44, 0f065830c, 6a25d9ed8, 040ec6466, 7fea9e8bf, e068fd11f, 9f6f8b20e, 87352b919, 0a3d39762, 214ba0d46, ec56f451a, fc94ae705, 46f3cdc58, 07241dc25, b5e7a9bbb, ad702fd3c, 0d712c8ee, 4ac6c26de, 8e3c5857d, 0ee83de94, 8e851a0fc, 3e0490b62, 7e12735be, d1415f3c1, 233e59848, 551e759b2, 7a70aa0de, 4a7ba3a0f, 0de27d360, eec7609f9, 3dc20787e, 2796a8c40, 67fd267d1, 8dbe0704d, 23b169b14, ec6cac40f, f69a84a8d, 120ad71fa, 08d6bf353, 2a48075c5, fa14d5eb7, 9ad847166, ad137a7e2, 6e44912d9, 39ca68f5d, b90248a39, 358a2c2c5, e404d2fd5, bd3c20f36, 4306bb29b
**Files changed:** 250
