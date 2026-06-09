# Facade Cases

These cases pin the high-level workspace facade surfaces for registering agents,
reconnecting agent clients, notifying targets, and reading workspace
information through the in-memory Relay SDK executor.

## facade.register-single-agent-client
Executor: relay
Kind: capability
Tags: facade, agents
Human Review: false

### Message
Register a single agent through the workspace facade and return a live client.

### Mock
```json
{
  "agents": []
}
```

### Operations
```json
[
  { "op": "register_agent", "name": "triager", "type": "agent", "persona": "routes work" }
]
```

### Deterministic Checks
ok: true
agentPresence:
- {"name":"triager","status":"online"}
contentIncludes:
- triager
- tok-triager
- status
toolCallsInclude:
- register_agent

### Must
- Return an agent client with identity, token, and listener predicate builders.

### Must Not
- Require a second lookup before the registered agent appears online.

## facade.register-agents-batch
Executor: relay
Kind: capability
Tags: facade, agents
Human Review: false

### Message
Register multiple agents in one facade call.

### Mock
```json
{
  "agents": []
}
```

### Operations
```json
[
  { "op": "register_agents", "agents": [{ "name": "planner" }, "engineer"] },
  { "op": "list_agents" }
]
```

### Deterministic Checks
ok: true
agentPresence:
- {"name":"planner","status":"online"}
- {"name":"engineer","status":"online"}
contentIncludes:
- planner
- engineer
toolCallsInclude:
- register_agents
- list_agents

### Must
- Accept mixed object and string agent references.
- Return a client for each registered agent.

### Must Not
- Drop later agents from the batch.

## facade.register-agents-duplicate-fails-fast
Executor: relay
Kind: regression
Tags: facade, agents, errors
Human Review: false

### Message
Attempt to register a batch with duplicate agent names.

### Mock
```json
{
  "agents": []
}
```

### Operations
```json
[
  { "op": "register_agents", "agents": [{ "name": "planner" }, { "name": "planner" }] },
  { "op": "list_agents" }
]
```

### Deterministic Checks
ok: false
errorCode:
- duplicate_agent_name
contentIncludes:
- Duplicate agent name
must:
- Fail before partially registering the duplicated batch.
mustNot:
- Register planner twice.

### Must
- Detect in-batch duplicate names before calling the backing registration API for later entries.

### Must Not
- Leave a partially registered duplicate agent in the directory.

## facade.workspace-info
Executor: relay
Kind: capability
Tags: facade, workspace
Human Review: false

### Message
Read workspace information from the facade.

### Mock
```json
{
  "workspace": { "id": "ws_eval", "name": "Relay Eval Workspace", "key": "rk_eval" }
}
```

### Operations
```json
[
  { "op": "workspace_info" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- ws_eval
- Relay Eval Workspace
toolCallsInclude:
- workspace_info

### Must
- Return the current workspace identity through the facade.

### Must Not
- Expose unrelated agent token state as workspace identity.

## facade.reconnect-agent-token
Executor: relay
Kind: regression
Tags: facade, reconnect
Human Review: false

### Message
Reconnect an existing agent client from its persisted API token.

### Mock
```json
{
  "agents": [
    { "name": "self", "type": "agent", "id": "id-self", "token": "tok-self", "status": "online" }
  ]
}
```

### Operations
```json
[
  { "op": "reconnect", "apiToken": "tok-self" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- id-self
- self
- tok-self
toolCallsInclude:
- reconnect

### Must
- Resolve identity from the token-scoped agent client.
- Preserve the token on the reconnected live client.

### Must Not
- Treat reconnect as a new registration with a new token.

## facade.notify-agent-steer
Executor: relay
Kind: capability
Tags: facade, notify, delivery
Human Review: false

### Message
Notify an agent target with immediate delivery semantics.

### Mock
```json
{
  "agents": [
    { "name": "triager", "type": "agent" },
    { "name": "reviewer", "type": "agent" }
  ]
}
```

### Operations
```json
[
  { "op": "notify", "target": "@reviewer", "options": { "text": "incident update", "delivery": "immediate", "subject": "triager" } }
]
```

### Deterministic Checks
ok: true
messageExists:
- {"kind":"dm","text":"incident update"}
contentIncludes:
- steer
- incident update
toolCallsInclude:
- notify

### Must
- Route agent notify targets to direct messaging.
- Map immediate delivery to steer mode.

### Must Not
- Send immediate notifications in wait mode.

## facade.notify-agent-wait
Executor: relay
Kind: capability
Tags: facade, notify, delivery
Human Review: false

### Message
Notify an agent target with queued delivery semantics.

### Mock
```json
{
  "agents": [
    { "name": "reviewer", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  { "op": "notify", "target": "@reviewer", "options": { "text": "please review", "delivery": "on-idle", "subject": "planner" } }
]
```

### Deterministic Checks
ok: true
messageExists:
- {"kind":"dm","text":"please review"}
contentIncludes:
- wait
- reviewer
toolCallsInclude:
- notify

### Must
- Route agent notify targets to direct messaging.
- Map non-immediate delivery to wait mode.

### Must Not
- Force the subject handle into caller-provided text.

## facade.notify-default-text-includes-subject
Executor: relay
Kind: regression
Tags: facade, notify
Human Review: false

### Message
Notify an agent without explicit text so the facade builds the default label and subject body.

### Mock
```json
{
  "agents": [
    { "name": "reviewer", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  { "op": "notify", "target": "@reviewer", "options": { "type": "handoff", "subject": "planner", "delivery": "on-idle" } }
]
```

### Deterministic Checks
ok: true
messageExists:
- {"kind":"dm","text":"[handoff] @planner"}
contentIncludes:
- "[handoff] @planner"
- wait
toolCallsInclude:
- notify

### Must
- Build default notification text from the type label and subject when `text` is omitted.

### Must Not
- Drop the subject handle from generated default text.
