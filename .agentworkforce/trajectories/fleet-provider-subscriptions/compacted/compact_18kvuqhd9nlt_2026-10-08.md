# Fleet provider subscriptions

Added integration subscribe --to self using the broker-assigned RELAY_AGENT_NAME and existing owner-authorized registered-agent subscription routing. Missing identities and spawn conflicts fail before subscription creation. Explicit recipient routing is preserved. Validation: 144 tests passed, 4 skipped; CLI typecheck passed; targeted lint passed with 31 existing warnings. Desktop session discovery is outside this repository and remains unchanged; live provider delivery was not tested. The task used isolated trajectory storage because the default store already had an unrelated active trajectory.

Decision: reuse the existing subscription channel and transactional setup instead of adding a second transport.

Changed files:

- `packages/cli/src/cli/commands/integration.ts`
- `packages/cli/src/cli/commands/integration-subscribe.test.ts`
- `packages/cli/README.md`
- `CHANGELOG.md`
- `summary.md`
