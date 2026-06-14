# Workspaces Cases

Workspaces cases pin workspace creation and workspace-key selection behavior for Relay SDK clients using the eval harness.

## workspaces.create-returns-usable-key

Executor: relay
Kind: capability
Tags: workspaces, create
Human Review: false

### Message

Create a new Relay workspace and verify the returned workspace key can be used by subsequent operations.

### Mock

```json
{}
```

### Operations

```json
[
  { "op": "create_workspace", "name": "Eval Workspace", "id": "ws_eval_create" },
  { "op": "register_agent", "name": "Lead", "type": "human" },
  { "op": "create_channel", "as": "Lead", "name": "created-workspace-room", "topic": "Workspace smoke" },
  { "op": "list_channels", "as": "Lead" }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- Eval Workspace
- rk_live_
- created-workspace-room
  toolCallsInclude:
- create_workspace
- register_agent
- create_channel
  minToolCalls: 4

### Must

- Return a workspace key with the Relay workspace-key prefix.
- Make the created workspace immediately usable by the registered agent.

### Must Not

- Require a separate set_workspace_key call after create_workspace succeeds.

## workspaces.set-key-selects-existing-workspace

Executor: relay
Kind: capability
Tags: workspaces, auth
Human Review: false

### Message

Set the SDK session to an existing workspace key and list that workspace's channels.

### Mock

```json
{
  "workspaces": [
    {
      "name": "Existing Workspace",
      "key": "rk_live_existing_eval",
      "agents": [{ "name": "Lead", "type": "human" }],
      "channels": [{ "name": "existing-room", "topic": "Existing topic", "members": ["Lead"] }]
    }
  ]
}
```

### Operations

```json
[
  { "op": "set_workspace_key", "workspaceKey": "rk_live_existing_eval" },
  { "op": "list_channels", "as": "Lead" }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- Existing Workspace
- existing-room
- Existing topic
  toolCallsInclude:
- set_workspace_key
- list_channels

### Must

- Select the seeded workspace by key.
- Resolve subsequent reads against the selected workspace.

### Must Not

- Leak channels from any other workspace.

## workspaces.switch-key-isolates-state

Executor: relay
Kind: regression
Tags: workspaces, isolation
Human Review: false

### Message

Switching workspace keys should isolate channel state between workspaces.

### Mock

```json
{
  "workspaces": [
    {
      "name": "Workspace One",
      "key": "rk_live_ws_one",
      "agents": [{ "name": "Lead", "type": "human" }],
      "channels": [{ "name": "alpha-room", "topic": "Alpha", "members": ["Lead"] }]
    },
    {
      "name": "Workspace Two",
      "key": "rk_live_ws_two",
      "agents": [{ "name": "Lead", "type": "human" }],
      "channels": [{ "name": "beta-room", "topic": "Beta", "members": ["Lead"] }]
    }
  ]
}
```

### Operations

```json
[
  { "op": "set_workspace_key", "workspaceKey": "rk_live_ws_one" },
  { "op": "list_channels", "as": "Lead" },
  { "op": "set_workspace_key", "workspaceKey": "rk_live_ws_two" },
  { "op": "list_channels", "as": "Lead" }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- alpha-room
- beta-room
  forbidPhrases:
- merged workspace channels

### Must

- Keep per-workspace channel state isolated.
- Change subsequent operation context after set_workspace_key.

### Must Not

- Merge channels from multiple workspaces into one listing.

## workspaces.invalid-key-format-rejected

Executor: relay
Kind: regression
Tags: workspaces, auth, errors
Human Review: false

### Message

A workspace key without the Relay live-key prefix should be rejected.

### Mock

```json
{}
```

### Operations

```json
[{ "op": "set_workspace_key", "workspaceKey": "not-a-relay-key" }]
```

### Deterministic Checks

ok: false
errorCode: invalid_workspace_key
toolCallsInclude:

- set_workspace_key

### Must

- Reject keys that do not start with the live workspace-key prefix.

### Must Not

- Mutate the active workspace when key validation fails.

## workspaces.create-duplicate-name-generates-distinct-key

Executor: relay
Kind: regression
Tags: workspaces, create, isolation
Human Review: false

### Message

Creating two workspaces with the same display name should produce distinct workspace records and keys.

### Mock

```json
{}
```

### Operations

```json
[
  { "op": "create_workspace", "name": "Duplicate Display Name", "id": "ws_dup_a" },
  { "op": "register_agent", "name": "Lead", "type": "human" },
  { "op": "create_channel", "as": "Lead", "name": "first-room", "topic": "First workspace" },
  { "op": "create_workspace", "name": "Duplicate Display Name", "id": "ws_dup_b" },
  { "op": "register_agent", "name": "Lead", "type": "human" },
  { "op": "list_channels", "as": "Lead" }
]
```

### Deterministic Checks

ok: true
contentIncludes:

- Duplicate Display Name
- rk_live_ws_dup_b
  toolCallsInclude:
- create_workspace
  minToolCalls: 6

### Must

- Allow display-name reuse by assigning a distinct workspace key.
- Start the second workspace with its own empty channel state.

### Must Not

- Reuse the first workspace solely because the display name matches.
