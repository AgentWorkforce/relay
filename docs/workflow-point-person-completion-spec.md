# Workflow Spec: Point-Person-Led Completion for Relay Workflows

## Status
Draft

## Problem
Relay workflow steps currently rely too heavily on explicit sentinel markers emitted by agents, such as:
- `STEP_COMPLETE:<step-name>`
- `REVIEW_DECISION:<...>`
- exact output markers embedded in prompts

This is brittle.

In real runs, agents often complete the substantive work but fail the step because they:
- forget a completion marker
- emit malformed review output
- add extra prose around the marker
- complete the task in-channel or via files/tool effects without matching the exact expected token

We observed this directly in real workflow runs:
- Codex lead/worker: lead posted `LEAD_DONE` and later `STEP_COMPLETE:lead`, but failed in the review phase because the review output was malformed (`missing REVIEW_DECISION`)
- Gemini lead/worker: worker completed, but lead never emitted the required `STEP_COMPLETE:lead`, so the step failed even though substantial work had occurred

This means the runner is treating marker ceremony as the source of truth instead of treating the workflow contract as the source of truth.

## Goal
Move completion responsibility to the **point person / owner / supervisor** layer.

A step should be considered complete when the point person can determine that the step contract has been satisfied based on evidence, not only when a worker emits an exact magic string.

## Non-Goals
- Remove all verification mechanisms
- Eliminate structured outputs entirely
- Replace deterministic checks with vague heuristics only
- Rework the entire workflow model in one pass

## Core Principle
**Markers are hints, not truth.**

The source of truth for completion should be:
1. configured step verification
2. observable execution evidence
3. point-person decision logic

## Definitions

### Worker / Specialist
The agent doing the direct task work.

### Owner / Point Person
The agent responsible for step oversight, recovery, and completion judgment.
This may be a lead, supervisor, reviewer, or auto-assigned owner.

### Completion Evidence
Any signal the runner can use to determine that the step contract has been fulfilled, including:
- verification success
- expected files created/modified
- expected stdout content
- expected channel messages/events
- expected tool-side effects
- owner/reviewer judgment

## Current Failure Modes
1. Worker does real work but omits `STEP_COMPLETE:*`
2. Lead/owner finishes coordination but omits exact completion marker
3. Reviewer output is semantically correct but malformed relative to a strict parser
4. Channel-based workflows succeed socially, but runner fails structurally
5. Gemini/Codex/Claude differ in verbosity and formatting, causing false negatives

## Proposed Model

### 1. Completion becomes evidence-based
The runner should evaluate step completion using a combination of:
- explicit verification result
- owner judgment
- execution evidence

The step should no longer hard-fail only because a sentinel marker is missing if other evidence strongly indicates completion.

### 2. Point person becomes the completion authority
For steps with an owner/point person:
- the owner is responsible for determining whether the worker has completed the assignment
- the owner may recover from worker formatting mistakes
- the owner may decide to complete, retry, nudge, or fail the step

This applies especially to:
- lead/worker workflows
- supervisor/reviewer workflows
- channel-coordination workflows
- multi-agent DAG steps with ownership semantics

### 3. Structured markers remain optional fast-paths
Markers such as `STEP_COMPLETE:*` and `REVIEW_DECISION:*` may still exist as:
- a fast-path for unambiguous completion
- a debugging aid
- a backward-compatibility mechanism

But they must not be the only successful path.

## Required Runner Changes

### A. Introduce a completion decision pipeline
For each agent step, after worker exit (or after a review/owner phase), the runner should evaluate:

1. **Hard verification outcome**
   - Did configured verification pass?
   - Examples:
     - `output_contains`
     - `file_exists`
     - future richer checks

2. **Observed evidence**
   - stdout/stderr output
   - files created/modified
   - channel posts / inbox events / coordination signals
   - tool-side effects
   - process exit status

3. **Owner decision**
   - If owner exists, ask owner/point person to classify the step:
     - COMPLETE
     - INCOMPLETE_RETRY
     - INCOMPLETE_FAIL
     - NEEDS_CLARIFICATION

4. **Fallback heuristic decision**
   - If no structured owner decision is available, use evidence + verification to decide

### B. Add explicit completion states
Current behavior is too binary. Add explicit internal states like:
- `completed_verified`
- `completed_by_owner_decision`
- `completed_by_evidence`
- `retry_requested_by_owner`
- `failed_verification`
- `failed_owner_decision`
- `failed_no_evidence`

This makes behavior inspectable and debuggable.

### C. Make review parsing tolerant
Current review handling is too brittle.

Instead of requiring exact `REVIEW_DECISION:*` as the only parseable outcome:
- first attempt strict structured parse
- if strict parse fails, fall back to tolerant parse
- if tolerant parse still fails, use owner evidence judgment
- only hard-fail when no structured or evidence-backed decision is possible

### D. Add owner recovery flow
If worker exits without explicit marker but evidence suggests likely completion:
1. runner asks point person to assess completion
2. point person may:
   - approve completion
   - request a corrective nudge
   - request rerun
   - fail with reason

### E. Channel workflows must treat channel state as first-class evidence
For workflows where completion is social/coordination-driven:
- channel events should be usable as evidence
- e.g. if worker posted `WORKER_DONE` to the channel, that matters
- if lead observed required worker done signals and posted summary output, that matters

The runner should not ignore the channel and only trust stdout markers.

## Proposed Owner Decision Contract

### Structured form (preferred)
The point person should ideally emit a structured decision, for example:

```text
OWNER_DECISION: COMPLETE
REASON: worker created expected output and verification passed
```

Other valid decisions:

```text
OWNER_DECISION: INCOMPLETE_RETRY
REASON: worker output missing required section
```

```text
OWNER_DECISION: INCOMPLETE_FAIL
REASON: worker never produced the requested artifact
```

```text
OWNER_DECISION: NEEDS_CLARIFICATION
REASON: ambiguous output; request one corrective follow-up
```
```

### Tolerant fallback
If the owner does not emit the exact structured form, the runner should still tolerate semantically equivalent outputs like:
- "Complete — the worker satisfied the task"
- "Retry: missing final artifact"
- "Fail — no evidence of completion"

This can be implemented via a tolerant parser and/or constrained owner prompts.

## Verification Precedence
Recommended precedence:

1. Deterministic verification failure with strong contradiction
   - fail unless owner explicitly requests retry and retries remain

2. Deterministic verification success
   - complete, even if sentinel missing

3. No deterministic verification, but strong evidence + owner approval
   - complete

4. Ambiguous evidence + owner requests retry
   - retry

5. Ambiguous evidence + no owner decision
   - fail conservatively with explicit reason

## Backward Compatibility
Phase rollout to avoid breaking existing workflows.

### Phase 1: Compatibility mode
- keep current markers supported
- add evidence-based fallback when markers missing
- log when completion succeeded without marker

### Phase 2: Warn on marker-only guidance
- update docs/skill to discourage hard dependence on markers
- encourage verification + owner judgment

### Phase 3: Markers optional by default
- remove marker requirement from normal success path
- preserve only as optimization / observability

## Skill / Authoring Changes
The workflow authoring guidance must change.

### Current bad guidance
- "Always end with STEP_COMPLETE"
- "Always emit REVIEW_DECISION"
- "Exact marker required or step fails"

### New guidance
- define a clear step contract
- prefer deterministic verification where possible
- use owner/reviewer/point-person to judge completion
- markers are optional hints, not mandatory truth
- for channel workflows, design explicit observable coordination evidence

## Suggested Authoring Rules After Change
1. Prefer `verification` over sentinel-only prompts
2. Use owners/reviewers to interpret ambiguous outputs
3. For channel workflows, define required channel events explicitly
4. Treat exact completion strings as optional accelerators only
5. Ensure prompts describe the work contract, not just output ceremony

## Implementation Plan

### Part 1: Runner internals
- locate completion logic in workflow runner
- separate:
  - worker execution
  - verification
  - owner/reviewer assessment
  - final completion decision
- add tolerant completion pipeline

### Part 2: Owner decision model
- introduce structured owner decision schema
- implement tolerant fallback parsing
- wire owner decision into step lifecycle

### Part 3: Channel evidence plumbing
- expose relevant channel events/messages to completion evaluation
- make channel-based completion evidence queryable by owner logic

### Part 4: Backward compatibility
- preserve existing marker support
- log when markers are absent but completion succeeds
- add migration notes

### Part 5: Docs / skill updates
- update workflow-writing docs/skill to stop teaching marker dependence
- add examples of evidence-based completion

## Test Plan

### Unit tests
1. Step completes when verification passes but marker missing
2. Step completes when owner approves despite malformed worker marker
3. Step retries when owner requests retry
4. Step fails when owner rejects and verification also fails
5. Review parser accepts tolerant equivalent outputs
6. Channel evidence contributes to completion decision

### Integration / E2E tests
1. Codex lead/worker where lead omits `STEP_COMPLETE`, but owner logic still completes
2. Gemini lead/worker where worker posts channel completion and owner finalizes step
3. Supervisor workflow where reviewer completes step without exact review sentinel
4. Map-reduce remains unaffected and still passes
5. Legacy marker-based workflows still pass unchanged

## Success Criteria
This change is successful if:
- lead/worker workflows no longer fail only due to missing exact completion markers
- malformed but semantically valid review outputs no longer hard-fail by default
- owner/supervisor role has real recovery authority
- deterministic verification remains authoritative when configured
- existing marker-based workflows continue to work

## Open Questions
1. Should owner decision always override verification failure?
   - Recommendation: no. Deterministic verification failure should remain strong evidence unless owner explicitly requests retry.

2. Should owner decision be required for all owned steps?
   - Recommendation: no. Use owner decision when available; otherwise use verification + evidence fallback.

3. Should channel evidence be first-class in the workflow schema?
   - Recommendation: yes, eventually. In the short term, allow internal evidence plumbing without requiring a schema redesign.

4. Should review be a separate explicit phase or folded into owner completion?
   - Recommendation: keep review phase conceptually separate, but do not require rigid exact-marker parsing.

## Recommended First Slice
Implement the smallest high-value change first:
1. if verification passes, do not fail solely for missing marker
2. if owner/reviewer output is malformed, try tolerant parse before hard fail
3. if channel evidence shows required coordination happened, let owner finalize the step

This first slice should resolve the concrete failures seen in the Codex and Gemini lead/worker runs without requiring a full workflow architecture rewrite.
