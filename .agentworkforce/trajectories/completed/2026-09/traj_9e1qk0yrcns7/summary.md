# Trajectory: diagnose-relay-orchestration-reliability-workflow

> **Status:** ✅ Completed
> **Task:** cdbfa60e5594b06da6af46ef
> **Confidence:** 95%
> **Started:** September 4, 2026 at 10:37 PM
> **Completed:** September 8, 2026 at 05:01 PM

---

## Summary

Repaired Fleet Daytona cleanroom candidate: final cleanup now rejects all remaining Fleet node records and inspects every returned node, configured credentials of any nonempty length are redacted, and live runs fail early without explicit immutable snapshot qualification inputs. Added offline/stale, secret-boundary, root-mount argv, and live-prerequisite tests; validation, dry-run, focused and broader fixtures, typecheck, lint, Prettier, and diff checks pass.

**Approach:** Standard approach

---

## Key Decisions

### Qualification uses deterministic harnesses as the authoritative gate and model agents only for evidence review/signoff
- **Chose:** Qualification uses deterministic harnesses as the authoritative gate and model agents only for evidence review/signoff
- **Reasoning:** The campaign is intended to expose flaky orchestration. A model verdict cannot substitute for exact baseline-fail, packed-candidate-pass, observed runtime identities, and resource-absence evidence.

### Count Fleet spawn confirmation as provisional, not proof
- **Chose:** Count Fleet spawn confirmation as provisional, not proof
- **Reasoning:** Invocation inv_221926944412856320 returned confirmed/spawned true, then launcher cleanup failed and authoritative node inventory showed zero agents; qualification must require node-associated live presence plus PID/work product.

### Replaced registry-byte equality for source packages with a portable source-bound Linux candidate closure
- **Chose:** Replaced registry-byte equality for source packages with a portable source-bound Linux candidate closure
- **Reasoning:** A real npm pack proved @agent-relay/sdk source tarballs cannot byte-equal published multi-platform release tarballs; qualification must upload and consume the exact candidate tarballs produced from the Relay SHA, while retaining registry integrity only for external protocol packages.

### Fail closed before Cloud workspace POST until bound deployment idempotency and reconciliation APIs ship
- **Chose:** Fail closed before Cloud workspace POST until bound deployment idempotency and reconciliation APIs ship
- **Reasoning:** Current deployed Cloud ignores the unknown relayfileCloudDeploymentId field, can create a workspace, then the candidate CLI rejects the unbound reveal-once response and loses the only cleanup identity, guaranteeing orphan risk.

### Fail closed on mutable Cloud evidence and queue-only set-model acknowledgements
- **Chose:** Fail closed on mutable Cloud evidence and queue-only set-model acknowledgements
- **Reasoning:** Qualification cannot claim end-to-end behavior when evidence can be overwritten or when the CLI proves only enqueueing instead of downstream application.

### Treat node agent set-model as queue admission until a provider-correlated receipt proves application
- **Chose:** Treat node agent set-model as queue admission until a provider-correlated receipt proves application
- **Reasoning:** Current broker response is accepted=true pending=true and every runtime lacks a request ID plus provider-confirmed effective-model state; the Fleet gate must fail closed rather than relabel a PTY write as application.

### Changed the Relay package producer from every main push to a manual main-only prerelease run
- **Chose:** Changed the Relay package producer from every main push to a manual main-only prerelease run
- **Reasoning:** The candidate gate must prove source packages are both prerelease and unpublished; attaching it to ordinary main pushes makes already-published stable versions fail by construction.

### Kept clean-install proof separate from live Fleet acceptance
- **Chose:** Kept clean-install proof separate from live Fleet acceptance
- **Reasoning:** Two Daytona sandboxes proved the exact Relay candidate package, broker digest, attestation, CLI surface, tests, and cleanup, but Cloud issues 3349/3351 still prevent binding the 95-operation Fleet board to an immutable candidate workspace and Relayfile data plane.

### Make exact candidate-bound two-node Fleet qualification the sole release gate
- **Chose:** Make exact candidate-bound two-node Fleet qualification the sole release gate
- **Reasoning:** The 95-operation harness is structurally sound, but production-snapshot fallback cannot prove the candidate. Cloud #3351 must land before any Fleet GREEN verdict.

### Fail closed when O_NOFOLLOW is unavailable
- **Chose:** Fail closed when O_NOFOLLOW is unavailable
- **Reasoning:** Qualification evidence must never use an lstat-then-open fallback because it leaves a symlink swap race; the Fleet/cleanroom acceptance environment is Linux and supported macOS hosts expose O_NOFOLLOW.

### Hardened Fleet release gate to require 95 operations plus five lifecycle trials per attempt
- **Chose:** Hardened Fleet release gate to require 95 operations plus five lifecycle trials per attempt
- **Reasoning:** A catalog-only pass cannot prove targeted placement, agent responsiveness, release absence, same-name reuse, or exact candidate binaries under repeated clean Daytona execution.

### Fail closed on qualification provenance inputs and constrain preflight egress
- **Chose:** Fail closed on qualification provenance inputs and constrain preflight egress
- **Reasoning:** Fresh PR review found exploitable symlink/path/ref boundary gaps and unrestricted model preflight networking. The qualification must reject ambiguous provenance instead of weakening its clean-room gate.

### Reviewed required repo and workflow skills; using a dedicated worktree and feature branch
- **Chose:** Reviewed required repo and workflow skills; using a dedicated worktree and feature branch
- **Reasoning:** Resident root contains unrelated dirty trajectory/tool files and must remain untouched; PR review requires isolated edits and tracked trajectory evidence.

### Require explicit qualification inputs for live Fleet runs and bind snapshot args to root-mount intent
- **Chose:** Require explicit qualification inputs for live Fleet runs and bind snapshot args to root-mount intent
- **Reasoning:** The 108-operation matrix requires immutable snapshot tokens for fleet-spawn-sandbox-root-mount, and no safe provider defaults exist; failing before workspace access keeps standalone behavior honest while the qualification workflow remains compatible.

### Treat any final Fleet node record as cleanup residue and inspect every returned node
- **Chose:** Treat any final Fleet node record as cleanup residue and inspect every returned node
- **Reasoning:** Baseline qualification requires zero Fleet node records, so offline/stale records must fail rather than be skipped by an online-only inventory loop.

---

## Chapters

### 1. Planning
*Agent: orchestrator*

### 2. Execution: lead-coordinate, cloud-diagnosis, relayfile-diagnosis, data-plane-diagnosis, static-gates
*Agent: orchestrator*

### 3. Execution: lead-coordinate
*Agent: lead*

### 4. Execution: cloud-diagnosis
*Agent: cloud-specialist*

### 5. Execution: relayfile-diagnosis
*Agent: relayfile-specialist*

### 6. Execution: data-plane-diagnosis
*Agent: data-plane-specialist*

### 7. Execution: relayfile-diagnosis
*Agent: relayfile-specialist*

### 8. Execution: data-plane-diagnosis
*Agent: data-plane-specialist*

### 9. Execution: data-plane-diagnosis
*Agent: data-plane-specialist*

### 10. Execution: relayfile-diagnosis
*Agent: relayfile-specialist*

### 11. Execution: cloud-diagnosis
*Agent: cloud-specialist*

- Expanded Relay reliability campaign from diagnostic coverage to gated fix-and-proof program under resident Chief: three fix trains are active, Fleet cross-node supervision is being established, and completion requires baseline-fail/candidate-pass clean-install evidence plus dual fresh review.
- Qualification uses deterministic harnesses as the authoritative gate and model agents only for evidence review/signoff: Qualification uses deterministic harnesses as the authoritative gate and model agents only for evidence review/signoff
- Chief spawned three cross-node leads, but the initial local-only brief handoff and subsequent recipient resolution/remote attach failures blocked real work; preserved these as Fleet defects, moved the exact brief into a Relay channel message, and required Chief to verify real PTYs before counting agents. Relay focused qualification gates are green; 258 MiB source Workerd gate is green but baseline and packed-candidate proofs remain missing.
- Count Fleet spawn confirmation as provisional, not proof: Count Fleet spawn confirmation as provisional, not proof
- Replaced registry-byte equality for source packages with a portable source-bound Linux candidate closure: Replaced registry-byte equality for source packages with a portable source-bound Linux candidate closure
- Deterministic qualification is exposing real gaps: Fleet spawn success without a resident agent, DM recipient resolution failure for an existing worker, response-reset data loss in the 258 MiB candidate, and stale provenance/scheduling/idempotency assumptions. Full-tree candidate hashing and portable tarball closure are now locally green; cross-repo consumption and live cleanroom proof remain open.
- Fail closed before Cloud workspace POST until bound deployment idempotency and reconciliation APIs ship: Fail closed before Cloud workspace POST until bound deployment idempotency and reconciliation APIs ship
- Fresh review converted apparent near-green gates into concrete blockers: transitive npm closure was not locked, 258 MiB acceptance used the wrong one-file workload, Cloud candidate binding could orphan workspaces, and fixed producer semantics were incomplete. Root safety gates now fail closed while exact producer and workload proofs are being strengthened.
- Fail closed on mutable Cloud evidence and queue-only set-model acknowledgements: Fail closed on mutable Cloud evidence and queue-only set-model acknowledgements
- Harness and dry-run gates are green, but live certification remains blocked by Relayflows sandbox source/ID propagation, Cloud write-once storage, set-model application receipts, and Relayfile Cloud/Fleet-path binding.
- Treat node agent set-model as queue admission until a provider-correlated receipt proves application: Treat node agent set-model as queue admission until a provider-correlated receipt proves application
- Changed the Relay package producer from every main push to a manual main-only prerelease run: Changed the Relay package producer from every main push to a manual main-only prerelease run
- Static and dry-run harness gates are green, but live qualification remains blocked by Cloud candidate binding/write-once evidence and version-skewed Fleet nodes; generic deletion evidence was hardened to exact target IDs plus GET 404.
- Kept clean-install proof separate from live Fleet acceptance: Kept clean-install proof separate from live Fleet acceptance
- Relay package lane is sealed; Relayflows review correctly stopped promotion on deeper shared-environment and provenance defects; set-model review stopped an unsupported/no-op implementation.
- Make exact candidate-bound two-node Fleet qualification the sole release gate: Make exact candidate-bound two-node Fleet qualification the sole release gate
- Fleet critical path is now Cloud atomic workspace binding -> exact candidate snapshot -> two clean Daytona nodes -> all 95 operations twice -> lifecycle/teardown proof -> independent reviews.
- Fail closed when O_NOFOLLOW is unavailable: Fail closed when O_NOFOLLOW is unavailable
- Hardened Fleet release gate to require 95 operations plus five lifecycle trials per attempt: Hardened Fleet release gate to require 95 operations plus five lifecycle trials per attempt
- Fleet proof code and deterministic gates are integrated and locally green; live candidate campaign remains gated by Cloud candidate-bound ephemeral workspaces, Relaycast crash-idempotency, and Relayfile 258 MiB acceptance.
- Fleet qualification normal CI is green, but immutable PR proof exposed Cloud sandbox_router_no_provider before allocation. Hardened verifier against 30+ review findings, preserved strict clean-workspace baseline, and added pre-spawn absence checks for reused lifecycle identities. Cloud, Relaycast, Relayfile, and set-model repairs are proceeding on isolated branches; live candidate proof remains intentionally RED until those land in a prerelease snapshot.
- Fail closed on qualification provenance inputs and constrain preflight egress: Fail closed on qualification provenance inputs and constrain preflight egress
- Reviewed required repo and workflow skills; using a dedicated worktree and feature branch: Reviewed required repo and workflow skills; using a dedicated worktree and feature branch
- Fresh PR #1665 review findings are repaired in an isolated feature worktree: descriptor-pinned candidate output, complete symlink provenance, structural policy and wiring regressions, per-lane Cloud agents, reviewer-owned sandbox provenance, and prerelease-only release trigger. Focused and full Vitest/typecheck/format checks are green; hosted E2E and Cloud proof failures were external runtime availability failures.
- Require explicit qualification inputs for live Fleet runs and bind snapshot args to root-mount intent: Require explicit qualification inputs for live Fleet runs and bind snapshot args to root-mount intent
- Treat any final Fleet node record as cleanup residue and inspect every returned node: Treat any final Fleet node record as cleanup residue and inspect every returned node
