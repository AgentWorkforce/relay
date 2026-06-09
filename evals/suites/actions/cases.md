# Actions Cases
Action cases verify registration, lookup, invocation results, policy decisions, and listener/audit events through InMemoryAgentRelayActions and ActionRegistry semantics.

## actions.register-and-invoke-echo
Executor: relay
Kind: regression
Tags: actions, register, invoke
Human Review: false

### Message
An agent registers an echo action and another agent invokes it successfully.

### Mock
```json
{
  "agents": [
    { "name": "builder", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "builder",
    "name": "echo",
    "description": "Echo text",
    "handlerFixture": "echo_text",
    "inputSchema": {
      "type": "object",
      "required": ["text"],
      "additionalProperties": false,
      "properties": { "text": { "type": "string", "minLength": 1 } }
    },
    "outputSchema": {
      "type": "object",
      "required": ["echoed"],
      "additionalProperties": false,
      "properties": { "echoed": { "type": "string" } }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": " echo ", "input": { "text": "hello relay" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- echoed
- hello relay
eventEmitted:
- action.invoked
- action.completed
toolCallsInclude:
- register_action
- invoke_action
must:
- Normalize action names by trimming whitespace before lookup.
- Return an ok action result with the handler output.
mustNot:
- Emit an action.failed event for a valid invocation.

## actions.list-descriptor-after-register
Executor: relay
Kind: capability
Tags: actions, descriptor
Human Review: false

### Message
A registered action should be visible through registry descriptor lookup with default visibility.

### Mock
```json
{
  "agents": [{ "name": "builder", "type": "agent" }]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "builder",
    "name": "sum",
    "description": "Add two numbers",
    "handlerFixture": "sum_numbers",
    "inputSchema": {
      "type": "object",
      "required": ["a", "b"],
      "properties": {
        "a": { "type": "number" },
        "b": { "type": "number" }
      }
    }
  }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- sum
- Add two numbers
- agent
must:
- Store the normalized action name in the descriptor.
- Default omitted visibility to `agent`.
mustNot:
- Drop the input schema from the descriptor.

## actions.invoke-sum-with-caller-context
Executor: relay
Kind: regression
Tags: actions, context, invoke
Human Review: false

### Message
Action invocation should carry the caller identity into listener and audit events.

### Mock
```json
{
  "agents": [
    { "name": "math-bot", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "math-bot",
    "name": "sum",
    "description": "Add numbers",
    "handlerFixture": "sum_numbers",
    "inputSchema": {
      "type": "object",
      "required": ["a", "b"],
      "properties": {
        "a": { "type": "number" },
        "b": { "type": "number" }
      }
    }
  },
  { "op": "invoke_action", "as": "planner", "name": "sum", "input": { "a": 2, "b": 5 }, "workspaceId": "ws_eval" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- 7
eventEmitted:
- { "type": "action.invoked", "action": "sum" }
- { "type": "action.completed", "action": "sum" }
must:
- Include caller `planner` in emitted action events.
- Return a successful output of 7.
mustNot:
- Invoke the action without caller context.

## actions.policy-denied-result
Executor: relay
Kind: capability
Tags: actions, policy, denied
Human Review: false

### Message
A policy-denied action returns an action_denied result and emits a denied event.

### Mock
```json
{
  "agents": [
    { "name": "guard", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "guard",
    "name": "restricted",
    "description": "Restricted action",
    "handlerFixture": "policy_deny"
  },
  { "op": "invoke_action", "as": "planner", "name": "restricted", "input": { "request": "delete" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- action_denied
- denied
eventEmitted:
- action.invoked
- action.denied
must:
- Return ok false with error code `action_denied`.
- Emit action.denied rather than action.completed.
mustNot:
- Run the handler after policy denial.

## actions.handler-throw-failed-result
Executor: relay
Kind: regression
Tags: actions, failure
Human Review: false

### Message
If a registered handler throws, invoke_action should return an action_failed result and emit failure events.

### Mock
```json
{
  "agents": [
    { "name": "builder", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "builder",
    "name": "explode",
    "description": "Throw an error",
    "handlerFixture": "throw_error"
  },
  { "op": "invoke_action", "as": "planner", "name": "explode", "input": { "text": "boom" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- action_failed
- fixture threw
eventEmitted:
- action.invoked
- action.failed
must:
- Convert the thrown error into an action result with ok false.
- Emit a listener-visible action.failed event.
mustNot:
- Throw out of invoke_action for handler failures.

## actions.unregister-handle-removes-action
Executor: relay
Kind: capability
Tags: actions, unregister, lookup
Human Review: false

### Message
The action handle returned by registration should be able to unregister the action.

### Mock
```json
{
  "agents": [
    { "name": "builder", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "builder",
    "name": "temporary",
    "description": "Temporary action",
    "handlerFixture": "echo_text",
    "unregisterAfter": true
  },
  { "op": "invoke_action", "as": "planner", "name": "temporary", "input": { "text": "should not run" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- action_not_found
must:
- Remove the action when its registration handle is unregistered.
- Return a not-found result on later invoke.
mustNot:
- Keep stale unregistered actions invokable.

## actions.listener-errors-do-not-break-invoke
Executor: relay
Kind: regression
Tags: actions, listeners, resilience
Human Review: false

### Message
A throwing registry listener should not prevent successful action invocation.

### Mock
```json
{
  "agents": [
    { "name": "builder", "type": "agent" },
    { "name": "planner", "type": "agent" }
  ],
  "actionListeners": [{ "fixture": "throwing_listener" }]
}
```

### Operations
```json
[
  {
    "op": "register_action",
    "as": "builder",
    "name": "echo",
    "description": "Echo text",
    "handlerFixture": "echo_text"
  },
  { "op": "invoke_action", "as": "planner", "name": "echo", "input": { "text": "listener resilience" } }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- listener resilience
- echoed
eventEmitted:
- action.invoked
- action.completed
must:
- Swallow listener exceptions during event emission.
- Complete the action successfully.
mustNot:
- Convert listener exceptions into action_failed results.
