# Trajectory: Implement terminal.set_delivery_mode for --node drive attach fix

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** August 12, 2026 at 11:49 PM
> **Completed:** August 16, 2026 at 05:15 PM

---

## Summary

relay#1536: fixed the readiness-gate status-mapping blocker (agent_not_found->404 incl. cross-node hint, unsupported_runtime->409, transport->503) via a single-sourced terminalErrorStatus(); extracted waitForTerminalReady() to collapse three duplicate await/timeout blocks; determinised the readiness test with a sentinel race plus a scheduling-independent pre-ready ordering flag; added a must-fire/must-not-fire test pair proved by three mutations. All four review threads answered and resolved; 11/11 CI workflows green at c73569e1c.

**Approach:** Standard approach

---

## Key Decisions

### Use oneshot channel to call handle_api_request for SetInboundDeliveryMode from fleet terminal handler
- **Chose:** Use oneshot channel to call handle_api_request for SetInboundDeliveryMode from fleet terminal handler
- **Reasoning:** handle_api_request is a method on BrokerRuntime that takes &mut self. Calling it from handle_terminal_control_event (also &mut self) is valid sequential Rust. The oneshot channel is used only for data handoff — tx.send() happens synchronously inside handle_api_request, rx.await() resolves immediately after. This reuses the exact HTTP code path including side effects: interactive-hold frame, sdk_out event emission, queue flush on transition.

### Address every live PR #1502 review thread in one follow-up: raw option presence, path-specific guidance, regression coverage, and changelog
- **Chose:** Address every live PR #1502 review thread in one follow-up: raw option presence, path-specific guidance, regression coverage, and changelog
- **Reasoning:** All five findings are valid or required by AGENTS.md; resolving the complete set avoids leaving the PR knowingly incomplete

### Single-sourced the terminal status mapping in terminalErrorStatus() rather than inlining the reviewers' suggested ternary at the readiness gate
- **Chose:** Single-sourced the terminal status mapping in terminalErrorStatus() rather than inlining the reviewers' suggested ternary at the readiness gate
- **Reasoning:** The same 404/409/503 chain already existed inline in the snapshot path and a partial copy (404 only) in the delivery-mode reply path; inlining a third copy is what let the new gate diverge to a hardcoded 503 in the first place. One helper, three callers, plus waitForTerminalReady() for the duplicated await/timeout block

### Proved every new/changed test bites by mutation before claiming coverage
- **Chose:** Proved every new/changed test bites by mutation before claiming coverage
- **Reasoning:** Three mutations: (A) restore hardcoded 503 in the gate -> the 404 and 409 tests fail; (B) terminalErrorStatus returns 404 unconditionally -> the ECONNREFUSED 503 test and three pre-existing lifecycle tests fail; (C) remove the readiness gate -> the determinised readiness test fails on the sentinel race at 7ms rather than on the sleep. A single new passing test proves novelty, not correctness

---

## Chapters

### 1. Work
*Agent: default*

- Use oneshot channel to call handle_api_request for SetInboundDeliveryMode from fleet terminal handler: Use oneshot channel to call handle_api_request for SetInboundDeliveryMode from fleet terminal handler
- Address every live PR #1502 review thread in one follow-up: raw option presence, path-specific guidance, regression coverage, and changelog: Address every live PR #1502 review thread in one follow-up: raw option presence, path-specific guidance, regression coverage, and changelog
- Single-sourced the terminal status mapping in terminalErrorStatus() rather than inlining the reviewers' suggested ternary at the readiness gate: Single-sourced the terminal status mapping in terminalErrorStatus() rather than inlining the reviewers' suggested ternary at the readiness gate
- Proved every new/changed test bites by mutation before claiming coverage: Proved every new/changed test bites by mutation before claiming coverage

---

## Artifacts

**Commits:** c73569e1c, bdcb3d80b, b42e47efa, c7f5c8116, 0d843597e, 62acd3736, 31947aa03, 9dcba76de, 87ada407c, 5028dadda, 92fd2db92, c9e88b4e1, adf28466e, 0cd0fb415, 888f1f5a9, 7c3495d8a, 6ce07031b, a3c291e7a, 75e969a96, b41bfe707, 620b1ef5a, 2d92cb152, 592d371a8, 3267b1b19, 67b52cafe, d398d4524, 74a4c9de5, df013c43f, 551b9eb3e, 51f914747, 88e30da29, be2287975, 65589c9e1, f3b2baf07, bbe8b0b57
**Files changed:** 172
