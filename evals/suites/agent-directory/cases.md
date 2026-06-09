# Agent Directory Cases
Agent directory cases pin agent registration, spawned worker lifecycle, directory listings, direct-message directory state, and online/offline presence behavior.

## agent-directory.register-agent-online
Executor: relay
Kind: capability
Tags: agents, register, presence
Human Review: false

### Message
Register a new worker agent and verify it appears online in the agent directory.

### Mock
```json
{}
```

### Operations
```json
[
  { "op": "register_agent", "name": "WorkerA", "type": "agent", "persona": "Builder" },
  { "op": "list_agents" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- WorkerA
- Builder
agentPresence:
- {"name":"WorkerA","status":"online"}
toolCallsInclude:
- register_agent
- list_agents

### Must
- Add the registered agent to the directory.
- Mark a freshly registered agent as online.

### Must Not
- Require a channel join before presence is visible.

## agent-directory.register-human-agent-type
Executor: relay
Kind: capability
Tags: agents, register
Human Review: false

### Message
Register a human operator identity and verify the directory preserves its type.

### Mock
```json
{}
```

### Operations
```json
[
  { "op": "register_agent", "name": "Operator", "type": "human" },
  { "op": "list_agents" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- Operator
- human
agentPresence:
- {"name":"Operator","status":"online"}

### Must
- Preserve the requested human type in the agent listing.

### Must Not
- Coerce every registered identity to type agent.

## agent-directory.register-duplicate-name-rejected
Executor: relay
Kind: regression
Tags: agents, register, errors
Human Review: false

### Message
Registering an agent name that already exists should fail deterministically.

### Mock
```json
{
  "agents": [
    { "name": "WorkerA", "type": "agent", "status": "online" }
  ]
}
```

### Operations
```json
[
  { "op": "register_agent", "name": "WorkerA", "type": "agent" }
]
```

### Deterministic Checks
ok: false
errorCode: agent_exists
agentPresence:
- {"name":"WorkerA","status":"online"}

### Must
- Reject duplicate agent names without replacing the existing identity.

### Must Not
- Mint a new token for an already registered name.

## agent-directory.add-agent-spawns-online
Executor: relay
Kind: capability
Tags: agents, spawn, presence
Human Review: false

### Message
Spawn a worker agent through add_agent and verify it appears online.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human", "status": "online" }
  ]
}
```

### Operations
```json
[
  { "op": "add_agent", "name": "WorkerB", "cli": "codex", "task": "Handle eval work", "persona": "Eval worker" },
  { "op": "list_agents", "status": "online" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- WorkerB
- Eval worker
agentPresence:
- {"name":"WorkerB","status":"online"}
toolCallsInclude:
- add_agent
- list_agents

### Must
- Add spawned agents to the directory as online.
- Preserve spawn metadata that is useful for auditing.

### Must Not
- Hide spawned agents from online-filtered listings.

## agent-directory.remove-agent-marks-offline
Executor: relay
Kind: regression
Tags: agents, remove, presence
Human Review: false

### Message
Removing a worker should transition its presence to offline while retaining directory history.

### Mock
```json
{
  "agents": [
    { "name": "WorkerB", "type": "agent", "status": "online" }
  ]
}
```

### Operations
```json
[
  { "op": "remove_agent", "name": "WorkerB", "reason": "done" },
  { "op": "list_agents" },
  { "op": "list_agents", "status": "offline" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- WorkerB
- offline
agentPresence:
- {"name":"WorkerB","status":"offline"}

### Must
- Mark the removed agent offline.
- Keep the offline agent visible to unfiltered and offline-filtered listings.

### Must Not
- Leave the removed agent marked online.

## agent-directory.remove-unknown-agent-rejected
Executor: relay
Kind: regression
Tags: agents, remove, errors
Human Review: false

### Message
Removing an unknown agent should fail without changing known agent presence.

### Mock
```json
{
  "agents": [
    { "name": "WorkerA", "type": "agent", "status": "online" }
  ]
}
```

### Operations
```json
[
  { "op": "remove_agent", "name": "MissingWorker", "reason": "not found" }
]
```

### Deterministic Checks
ok: false
errorCode: agent_not_found
agentPresence:
- {"name":"WorkerA","status":"online"}

### Must
- Return a deterministic not-found error for missing agents.

### Must Not
- Create an offline placeholder for the missing agent.

## agent-directory.list-agents-status-filters
Executor: relay
Kind: capability
Tags: agents, list, presence
Human Review: false

### Message
Online and offline status filters should return only agents matching the requested presence.

### Mock
```json
{
  "agents": [
    { "name": "OnlineWorker", "type": "agent", "status": "online" },
    { "name": "OfflineWorker", "type": "agent", "status": "offline" }
  ]
}
```

### Operations
```json
[
  { "op": "list_agents", "status": "online" },
  { "op": "list_agents", "status": "offline" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- OnlineWorker
- OfflineWorker
agentPresence:
- {"name":"OnlineWorker","status":"online"}
- {"name":"OfflineWorker","status":"offline"}

### Must
- Honor online and offline filters independently.

### Must Not
- Treat every listed agent as online.

## agent-directory.list-channels-reflects-membership
Executor: relay
Kind: capability
Tags: agents, channels, list
Human Review: false

### Message
List channels after a worker joins a channel and verify membership is reflected in the directory-facing listing.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "WorkerA", "type": "agent" }
  ],
  "channels": [
    { "name": "alpha", "topic": "Alpha", "members": ["Lead"] },
    { "name": "beta", "topic": "Beta", "members": ["Lead"] }
  ]
}
```

### Operations
```json
[
  { "op": "join_channel", "as": "WorkerA", "channel": "alpha" },
  { "op": "list_channels", "as": "WorkerA" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- alpha
- beta
channelMembers:
- {"channel":"alpha","members":["Lead","WorkerA"]}
- {"channel":"beta","members":["Lead"]}

### Must
- Reflect the worker's joined membership in list_channels.
- Preserve channels the worker has not joined.

### Must Not
- Treat list_channels as only the caller's joined channels unless the executor documents such a filter.

## agent-directory.list-dms-after-direct-message
Executor: relay
Kind: capability
Tags: agents, dms, list
Human Review: false

### Message
After a direct message is sent, the sender should see the direct-message conversation in list_dms.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "WorkerA", "type": "agent" }
  ]
}
```

### Operations
```json
[
  { "op": "send_dm", "as": "Lead", "to": "WorkerA", "text": "Please review the channel suite.", "id": "dm_agents_1" },
  { "op": "list_dms", "as": "Lead" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- WorkerA
- Please review the channel suite.
messageExists:
- {"kind":"dm","text":"Please review the channel suite.","from":"Lead"}
toolCallsInclude:
- send_dm
- list_dms

### Must
- Create or update a DM conversation for the sender and recipient.
- Include the latest direct-message content in the conversation summary.

### Must Not
- Expose the DM as a public channel message.

## agent-directory.list-dms-is-agent-scoped
Executor: relay
Kind: regression
Tags: agents, dms, privacy
Human Review: false

### Message
Direct-message listings should be scoped to the acting agent.

### Mock
```json
{
  "agents": [
    { "name": "Lead", "type": "human" },
    { "name": "WorkerA", "type": "agent" },
    { "name": "WorkerB", "type": "agent" }
  ],
  "messages": [
    { "id": "dm_seed_1", "kind": "dm", "from": "Lead", "to": "WorkerA", "text": "Private A" },
    { "id": "dm_seed_2", "kind": "dm", "from": "Lead", "to": "WorkerB", "text": "Private B" }
  ]
}
```

### Operations
```json
[
  { "op": "list_dms", "as": "WorkerA" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- Private A
forbidPhrases:
- Private B

### Must
- Return conversations involving the acting agent.

### Must Not
- Leak unrelated direct-message conversations to another agent.

## agent-directory.presence-offline-agent-cannot-act
Executor: relay
Kind: regression
Tags: agents, presence, errors
Human Review: false

### Message
An offline agent should not be allowed to perform channel membership operations as that identity.

### Mock
```json
{
  "agents": [
    { "name": "OfflineWorker", "type": "agent", "status": "offline" }
  ],
  "channels": [
    { "name": "ops", "topic": "Operations", "members": [] }
  ]
}
```

### Operations
```json
[
  { "op": "join_channel", "as": "OfflineWorker", "channel": "ops" }
]
```

### Deterministic Checks
ok: false
errorCode: agent_offline
agentPresence:
- {"name":"OfflineWorker","status":"offline"}
channelMembers:
- {"channel":"ops","members":[]}

### Must
- Reject acting as an offline identity.

### Must Not
- Bring an offline agent online implicitly because it attempted an operation.
