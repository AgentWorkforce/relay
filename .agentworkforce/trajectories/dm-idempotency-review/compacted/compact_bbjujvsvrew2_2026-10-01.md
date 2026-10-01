# Trajectory Compaction: 2026-10-01 - 2026-10-01

## Summary
Reviewed PR #1875 (DM idempotency key forwarding) and identified a P2 defect where whitespace-only idempotency keys are accepted but produce non-idempotent behavior. Testing showed the real SDK trims the key to empty string and generates a random key per attempt, causing a fresh-process proof to return msg_1 then msg_2 with two distinct rows in the database for a three-space key input. All automated tests passed (67 MCP tests, 180 SDK tests, 6 type tests, typecheck), but the whitespace-only key edge case was documented in review.md without issuing a clean review approval. The review session established that passing automated tests is necessary but not sufficient for clean approval when edge-case behavior violates idempotency guarantees. The decision to withhold approval was based on observing real-world SDK behavior through fresh-process proofs, demonstrating that empirical validation catches semantic defects that unit tests may miss. No code changes were made during this review; the finding was documented for the PR author to address.

## Key Decisions (1)
| Question | Decision | Impact |
|----------|----------|--------|
| Should PR #1875 receive clean approval despite passing all automated tests? | Withhold clean review approval and document P2 defect for whitespace-only idempotency keys | Prevents merging code with a semantic defect in idempotency guarantees. Establishes that empirical fresh-process proofs can reveal edge-case failures missed by unit tests. PR author must address whitespace handling before approval. |

## Conventions Established
- **Use fresh-process proofs to validate idempotency claims empirically, not just automated test suite results**: All 253 automated tests passed, but a fresh-process proof with a whitespace-only key exposed that the SDK generates random keys per attempt, creating duplicate database rows. Unit tests missed this edge case. (scope: PR reviews for idempotency features, DM forwarding, and SDK protocol correctness)
- **Document P2 defects in review.md and withhold clean approval even when tests pass**: Passing tests are necessary but not sufficient for approval. Edge-case semantic defects (like whitespace-only keys breaking idempotency) must be addressed before merge to prevent production issues. (scope: All PR reviews, especially for protocol-level features like idempotency keys)

## Lessons Learned
- Automated test suites can pass while missing critical edge cases in idempotency logic (PR #1875 had 67 MCP tests, 180 SDK tests, and 6 type tests all passing, yet a manual fresh-process proof with a three-space idempotency key revealed the SDK trims to empty and generates random keys per attempt, producing two database rows instead of one.) - Add automated tests for whitespace-only and empty-string idempotency keys. Extend the test suite to verify that trimmed/empty keys either reject or generate stable idempotent behavior, not random keys per attempt.
- Fresh-process proofs (restarting the SDK process between attempts) are essential for validating cross-process idempotency (The defect only surfaced when running the SDK in separate processes (msg_1 then msg_2 with two database rows). In-process tests likely reused a cached key or state that masked the random key generation.) - For idempotency features, always include at least one fresh-process integration test in the CI suite. Consider adding a test harness that spawns separate Node.js processes to verify cross-process behavior.

## Open Questions
- Should the SDK reject whitespace-only idempotency keys at the API boundary, or should it normalize them to a stable value?
- Are there other input edge cases (null, undefined, very long strings) that should be validated in the idempotency key handling?
- Should the MCP test suite include fresh-process proofs as standard practice for protocol-level features, or is that scope better suited for integration tests?
- What is the correct behavior when an idempotency key trims to empty — generate a random key, reject the request, or treat it as no key provided?

## Stats
- Sessions: 1, Agents: default, Files: 0, Commits: 0
- Date range: 2026-10-01T20:47:02.549Z - 2026-10-01T20:47:55.282Z