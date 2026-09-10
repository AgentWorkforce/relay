# PR 1726 follow-up review — 2026-09-10

New CodeRabbit and Cursor findings arrived after the rebase validation.

- Reset restored local deliveries' failed transport budget at load time. The new regression reproduced a dropped delivery when the worker was already registered before the first retry, then passed after the fix. Remote retry budgets remain unchanged.
- Normalize bracketed IPv6 before local-only loopback validation; the process proof now starts with `[::1]`.
- Remove Relaycast identity and telemetry variables after all child environment injection. A real shell child proves the variables and credentials are absent.
- Clarify that absent local recipients retain queued work, restarted recipients receive a fresh transport budget, and only a configured digest-matching audit destination can drain a backlog.
- Keep `[Unreleased - Minor]`: AGENTS.md explicitly requires a release level for pending user-visible changes. The review suggestion to remove the level conflicts with that instruction.

Validation: 1,100 Rust tests passed (4 ignored), strict Clippy passed, formatting and diff checks passed, and the updated local process proof passed. The preceding head's Cloud red-green proof passed in run 34472224310. New-head CI remains pending at this record's creation.

The trajectory CLI refused a new trajectory because an unrelated subscription-demo trajectory is active. This separate record preserves review evidence without modifying that task's state.
