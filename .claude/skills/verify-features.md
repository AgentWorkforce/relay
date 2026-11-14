# verify-features

Use when you need to verify that a specific feature or set of features works correctly from a user perspective, or when checking system health after a code change.

## What this skill covers

- Reading the feature manifest to understand what exists
- Running end-to-end verification of features by tier
- Identifying which features to verify given a specific code change
- Diagnosing failures and determining root cause

## Feature manifest location

```text
.agentworkforce/features/manifest.yaml    # every feature, criticality, location
.agentworkforce/features/critical-paths.md  # what must work for the product to function
.agentworkforce/features/verify/procedures.md  # step-by-step verification by tier
```

## Automation

```text
workflows/verify-features.ts            # runs tiers 1-6 + critical paths 1-6
workflows/audit-feature-manifest.ts     # checks the manifest still matches the CLI
scripts/audit-feature-manifest.mjs      # the audit itself; run it directly
```

Before trusting any verification result, check two things:

1. **Which CLI ran.** `verify-features.ts` has a `provenance` step that fails
   when `relay version` disagrees with the repo's `package.json`. A run against
   a stale globally-installed CLI describes that CLI, not your checkout — this
   has already produced a full green run plus one bogus "unknown command"
   failure against a real command.
2. **What was skipped.** Every check records `pass`, `fail`, or `skip` with a
   reason into `.workflow-artifacts/verify-features/checks.jsonl`, and
   `verdict.json` is the authoritative result. A SKIP means _not verified_.
   Never read a skip as a pass.

Run the manifest audit before adding checks, so you are not writing coverage
against a stale map:

```bash
node scripts/audit-feature-manifest.mjs          # human-readable
node scripts/audit-feature-manifest.mjs --json   # for tooling
```

Exit 0 = clean, 1 = drift, 2 = the audit itself could not run. Exit 2 is
deliberately distinct: a broken audit must never be read as a clean manifest.

## How to use it

### 1. Read the manifest to find the feature

```bash
# Prefer a structural query: category/feature length and indentation can change.
if command -v yq >/dev/null 2>&1; then
  yq '.categories."messaging-messages"' .agentworkforce/features/manifest.yaml
  yq '.. | select(type == "!!map" and .id == "message-post")' .agentworkforce/features/manifest.yaml
else
  # Fallback for environments without mikefarah/yq: stop at the next sibling
  # category/feature instead of assuming a fixed number of following lines.
  awk '
    $0 == "  messaging-messages:" { in_category = 1 }
    in_category && $0 != "  messaging-messages:" && /^  [[:alnum:]][[:alnum:]-]*:$/ { exit }
    in_category { print }
  ' .agentworkforce/features/manifest.yaml
  awk '
    $0 == "      - id: message-post" { in_feature = 1 }
    in_feature && $0 != "      - id: message-post" && /^      - id: / { exit }
    in_feature && /^  [[:alnum:]][[:alnum:]-]*:$/ { exit }
    in_feature { print }
  ' .agentworkforce/features/manifest.yaml
fi
```

The manifest tells you:

- `criticality` — how important is this feature
- `verify_tier` — what's required to verify it (1=nothing, 2=local Relay from `relay init`, 3=agent token, 4=two agents, 5=cloud, 6=manual)
- `location` — which source files implement it
- `status: legacy` — a category on a path the core replaces, verified by hand on demand, never on a pull request
- `verification.categories` — the named procedure in `verify/procedures.md` that supplies prerequisites, commands, assertions, cleanup, and automation limits

### 2. Check verify tier requirements

| Tier | Primary environment                       | Important qualification                                                        |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | Isolated local CLI/filesystem             | May still mutate local config; use a temp directory.                           |
| 2    | Local Relay                               | Run `relay init` in a sandboxed home; it starts the local server and the core. |
| 3    | Hosted workspace + one agent              | Requires an explicit workspace key/API.                                        |
| 4    | Hosted workspace + two agents             | Use separate actor tokens for cross-agent assertions.                          |
| 5    | Authenticated disposable external service | Use a test workspace, receiver, or account and clean it up.                    |
| 6    | Interactive/pre-provisioned integration   | Browser, SSH, PTY, provider credentials, or external callback may be required. |

### 3. Run the verification

Resolve the category through `verification.categories`, then follow the matching procedure in `.agentworkforce/features/verify/procedures.md`. Always run lower prerequisites first.

**Quick sanity check after any change:**

Start with the `Fast Health Triage` sequence in `critical-paths.md`; use the hosted-workspace fixture in `procedures.md` before attempting channel or message checks.

### 4. Determine which features to verify for a given change

| Changed code area                                                                 | Verify these feature categories |
| --------------------------------------------------------------------------------- | ------------------------------- |
| `crates/relay-node/`                                                              | core, core-delivery, init       |
| `packages/cli/src/cli/commands/init.ts`, `packages/cli/src/cli/lib/relay-node.ts` | init, core                      |
| `packages/cli/src/cli/commands/`                                                  | The command that changed        |
| `packages/cli/src/cli/mcp/`                                                       | mcp category (all tools)        |
| `packages/sdk/`                                                                   | sdk category                    |
| `packages/cloud/`                                                                 | cloud category                  |

### 5. Check critical paths last

Always run the applicable critical paths from `critical-paths.md` before declaring a change verified:

1. `relay init` for your tools
2. A message reaches a running session
3. Cross-agent channel message
4. MCP stdio round trip
5. Local workflow run/logs/sync
6. Direct message and read receipt

## When to update the manifest

Add or update entries in `manifest.yaml` when:

- A new CLI command is added
- An MCP tool is added or renamed
- A new harness is supported
- A feature is removed or deprecated

Then run `node scripts/audit-feature-manifest.mjs` and confirm `MANIFEST_CLEAN`.
Note that `manifest-contract.test.ts` cannot catch a missing entry for a _new_
command — a new command is absent from both the manifest and that test's
hardcoded expectation list, so it passes. The audit script derives the surface
from `--help` and `tools/list` instead, which is why it is the check that
matters here. Add new commands to both.

Update `critical-paths.md` when:

- A new path becomes foundational to the product
- A critical path sequence changes (commands renamed, flags changed)

## Example: verifying after a messaging change

```text
1. Read the manifest category and resolve its verification procedure.
2. Create the exact disposable fixture stated by that procedure.
3. Run every listed command and assert values written by the test are read back.
4. Run the applicable critical path with separate agents where required.
5. Perform the procedure's cleanup and prove the test resources are gone.
```
