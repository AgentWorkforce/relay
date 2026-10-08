# Explain fleet name reuse after release

`fleet release` retains the Relaycast identity by default, so respawning a stalled or never-launched worker under the same name can fail with `agent_already_exists`. Fleet spawn now explains that retention and directs owners to run `agent-relay fleet release <name> --delete-agent` in the same workspace before retrying. The guidance explicitly describes permanent identity deletion and provider binding retirement.

Release behavior remains unchanged. The `--delete-agent` help now explains name reuse. Targeted and automatic spawn errors retain their original cause, placement code, state, invocation ID and receipts. No automatic identity deletion or recovery is introduced.

Regression tests cover both targeted registration failures and automatic failed invocations, assert structured error correlation and no automatic release, and ensure unrelated spawn failures receive no deletion advice. Existing release cleanup tests continue to pass.

Validation:

- `npx vitest run packages/cli/src/cli/commands/fleet.test.ts` — passed, 89 tests.
- `npm run typecheck` — passed.
- `npm --prefix packages/cli run lint` — passed with 109 warnings and zero errors.
- `git diff --check` — passed.

Includes a patch changelog entry. No workflow files changed.
