# Per-agent model pins in teams.json

Agents configured with `{"name":"Worker","cli":"claude","model":"opus"}` now retain their model pin through config loading and `up` auto-spawn (including `up --spawn`). The config schema and core spawn API expose the optional field. Model names are trimmed; invalid or empty values warn and are omitted without dropping the agent. Normalization preserves role/task and excludes unknown agent keys.

Harness-specific handling stays in the existing broker path, which already carries model on the wire and emits model arguments for Claude, Codex, and OpenCode. No second TypeScript translation layer or catalog validation is introduced. Explicit inline `--model`/`-m` continues to win. The CLI doc-comment now recommends a separate model field and explains the inline-argument escape hatch and its node-capacity limitation.

The obsolete public `mapModelToCli` and `getBaseCli` helpers are deprecated for removal next major. Their root and subpath exports remain intact: the reviewed plan reserved breaking removal for a release-level decision, so this change takes the compatibility-preserving option and raises the pending changelog to Minor. `model-commands.ts`, broker colon-syntax branches, and node-capacity normalization remain follow-ups. No workflow files or production Rust code changed.

Validation:

- `npm test -w @agent-relay/config`: 103 passed, including loader normalization and schema round-trip/description regressions.
- `npm run build -w @agent-relay/config`: passed.
- `npm test -w @agent-relay/utils`: 235 passed.
- Focused CLI run (`core.test.ts`, `fleet-sidecar.test.ts`, `client-factory.test.ts`): 178 passed, including model forwarding for Claude, Codex, OpenCode, and inline arguments. The existing exact no-model spawn assertion remains green.
- Full CLI run (`npx vitest run packages/cli/src`): 1,885 passed, 17 skipped, 2 failed. Both failures reproduce on unmodified `b274b7a` in an isolated worktree: `sdk-client.test.ts` expects no gateway URL but receives `https://cast.agentrelay.com`; `fleet-lifecycle-integration.test.ts` exits from local-agent routing.
- Added a hermetic broker test covering all four inline model override forms and the no-override path using Claude. `cargo test -p agent-relay-broker model` could not run because Cargo/Rust is not installed; broker model and ordered-PTY-argument tests remain unverified here.
- Formatting and `git diff --check`: passed.
