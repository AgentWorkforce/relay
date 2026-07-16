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
grep -A 10 "category: messaging-messages" .agentworkforce/features/manifest.yaml

# Find a feature by id
grep -A 8 "id: message-post" .agentworkforce/features/manifest.yaml
```

The manifest tells you:

- `criticality` — how important is this feature
- `verify_tier` — what's required to verify it (1=nothing, 2=broker, 3=agent token, 4=two agents, 5=cloud, 6=manual)
- `location` — which source files implement it

### 2. Check verify tier requirements

| Tier | Requires             | Setup command                                                                    |
| ---- | -------------------- | -------------------------------------------------------------------------------- |
| 1    | Nothing              | (none)                                                                           |
| 2    | Broker running       | `relay node up --background`                                                     |
| 3    | Broker + agent token | `relay node up --background && relay agent register <name>`                      |
| 4    | Broker + 2 agents    | `relay node up --background && relay agent register a && relay agent register b` |
| 5    | Cloud auth           | `relay cloud whoami` (must already be logged in)                                 |
| 6    | Manual only          | Human must verify in browser or interactive session                              |

### 3. Run the verification

Follow `.agentworkforce/features/verify/procedures.md` for the relevant tier. Always start from the lowest tier that applies and work up.

**Quick sanity check after any change:**

```bash
relay version && \
relay status || relay node up --background && \
relay status && \
export RELAY_AGENT_TOKEN=$(relay agent register quick-check | jq -r '.token') && \
relay agent list && \
relay channel create quick-check-ch && \
relay channel join quick-check-ch && \
relay message post quick-check-ch "sanity $(date)" && \
relay message list quick-check-ch --limit 1 && \
relay channel archive quick-check-ch && \
relay agent remove quick-check
```

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

Always run the 5 critical paths from `critical-paths.md` before declaring a change verified:

1. `broker-up` → `agent-register` → `agent-list` → `status`
2. Channel create → join → post → list (two agents)
3. `local agent spawn` → `hold` → `flush` → `release`
4. `relay mcp` → `list_channels` → `post_message` → `list_messages`
5. `local workflow run` (basic workflow)

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
1. Read the manifest: grep "messaging-messages" manifest.yaml → verify_tier: 3
2. Setup: relay node up --background && export RELAY_AGENT_TOKEN=$(relay agent register test-agent | jq -r '.token')
3. Follow tier 3 procedures: post → list → reply → get_thread → search
4. Run critical path 2 (channel messaging) with two agents
5. Clean up: relay agent remove test-agent
```
