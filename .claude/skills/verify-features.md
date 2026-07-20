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

## How to use it

### 1. Read the manifest to find the feature

```bash
# View all features in a category
grep -A 60 "^  messaging-messages:" .agentworkforce/features/manifest.yaml

# Find a feature by id
grep -A 8 "id: message-post" .agentworkforce/features/manifest.yaml
```

The manifest tells you:

- `criticality` — how important is this feature
- `verify_tier` — what's required to verify it (1=nothing, 2=broker, 3=agent token, 4=two agents, 5=cloud, 6=manual)
- `location` — which source files implement it
- `verification.categories` — the named procedure in `verify/procedures.md` that supplies prerequisites, commands, assertions, cleanup, and automation limits

### 2. Check verify tier requirements

| Tier | Primary environment                       | Important qualification                                                        |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| 1    | Isolated local CLI/filesystem             | May still mutate local config; use a temp directory.                           |
| 2    | Local broker                              | Start with `relay node up --background --no-spawn`.                            |
| 3    | Hosted workspace + one agent              | Requires explicit workspace key/API, not merely a broker.                      |
| 4    | Hosted workspace + two agents             | Use separate actor tokens for cross-agent assertions.                          |
| 5    | Authenticated disposable external service | Use a test workspace, receiver, or account and clean it up.                    |
| 6    | Interactive/pre-provisioned integration   | Browser, SSH, PTY, provider credentials, or external callback may be required. |

### 3. Run the verification

Resolve the category through `verification.categories`, then follow the matching procedure in `.agentworkforce/features/verify/procedures.md`. Always run lower prerequisites first.

**Quick sanity check after any change:**

Start with the `Fast Health Triage` sequence in `critical-paths.md`; use the hosted-workspace fixture in `procedures.md` before attempting channel or message checks.

### 4. Determine which features to verify for a given change

| Changed code area                | Verify these feature categories         |
| -------------------------------- | --------------------------------------- |
| `crates/broker/`                 | broker, messaging-\*, local-agents, mcp |
| `crates/relay-pty/`              | local-agents (spawn/attach)             |
| `packages/cli/src/cli/commands/` | The command that changed + broker       |
| `packages/cli/src/cli/mcp/`      | mcp category (all tools)                |
| `packages/harness-driver/`       | harnesses, local-agents                 |
| `packages/sdk/`                  | sdk category                            |
| `packages/cloud/`                | cloud category                          |

### 5. Check critical paths last

Always run the applicable critical paths from `critical-paths.md` before declaring a change verified:

1. Local broker lifecycle
2. Cross-agent channel message
3. Managed local-agent lifecycle (when a provider is available)
4. MCP stdio round trip
5. Local workflow run/logs/sync
6. Direct message and read receipt

## When to update the manifest

Add or update entries in `manifest.yaml` when:

- A new CLI command is added
- An MCP tool is added or renamed
- A new harness is supported
- A feature is removed or deprecated

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
