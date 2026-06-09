# Capabilities Cases
Capability cases verify RelayCapabilityError paths and unsupported capability reporting for delivery and agent-scoped relay operations.

## capabilities.delivery-runner-requires-server-state
Executor: relay
Kind: regression
Tags: capabilities, delivery, error, pending-executor
Human Review: true

### Message
DeliveryRunner should refuse to start without server-backed delivery state support.

### Mock
```json
{
  "agents": [{ "name": "worker", "type": "agent" }],
  "inbox": [
    { "id": "in_cap_1", "recipient": "worker", "from": "lead", "text": "Cannot durable ack" }
  ],
  "delivery": {
    "target": "worker",
    "serverDeliveryState": false,
    "result": { "status": "delivered" }
  }
}
```

### Operations
```json
[
  { "op": "deliver", "as": "worker", "mode": "wait", "reason": "message" }
]
```

### Deterministic Checks
must:
- Throw before connecting the delivery adapter.
- Expose the missing capability name.
mustNot:
- Inject or ack messages when durable delivery state is unavailable.

## capabilities.delivery-unsupported-does-not-inject
Executor: relay
Kind: regression
Tags: capabilities, delivery, guard, pending-executor
Human Review: true

### Message
Unsupported delivery state should stop the delivery operation before any inbox item is consumed.

### Mock
```json
{
  "agents": [{ "name": "worker", "type": "agent" }],
  "inbox": [
    { "id": "in_cap_2", "recipient": "worker", "from": "lead", "text": "First" },
    { "id": "in_cap_3", "recipient": "worker", "from": "lead", "text": "Second" }
  ],
  "delivery": {
    "target": "worker",
    "serverDeliveryState": false,
    "result": { "status": "delivered" }
  }
}
```

### Operations
```json
[
  { "op": "deliver", "as": "worker", "mode": "steer", "reason": "mention" }
]
```

### Deterministic Checks
must:
- Fail fast before processing `in_cap_2`.
- Leave both inbox items unacknowledged.
mustNot:
- Partially process queued items after capability failure.

## capabilities.missing-agent-client-send-message
Executor: relay
Kind: capability
Tags: capabilities, messaging, agent-client, pending-executor
Human Review: true

### Message
Agent-scoped message operations require an agent client capability.

### Mock
```json
{
  "agents": [{ "name": "observer", "type": "agent" }],
  "channels": [{ "name": "general", "members": ["observer"] }],
  "clientCapabilities": { "agentClient": false }
}
```

### Operations
```json
[
  { "op": "post_message", "as": "observer", "channel": "general", "text": "Should require an agent client", "id": "msg_cap_1" }
]
```

### Deterministic Checks
must:
- Surface a RelayCapabilityError for the missing agent-scoped operation.
mustNot:
- Create `msg_cap_1` without an agent client.

## capabilities.missing-agent-client-channel-join
Executor: relay
Kind: capability
Tags: capabilities, channels, agent-client, pending-executor
Human Review: true

### Message
Channel membership mutations require an agent-scoped client capability.

### Mock
```json
{
  "agents": [{ "name": "observer", "type": "agent" }],
  "channels": [{ "name": "general", "members": [] }],
  "clientCapabilities": { "agentClient": false }
}
```

### Operations
```json
[
  { "op": "join_channel", "as": "observer", "channel": "general" }
]
```

### Deterministic Checks
must:
- Reject join_channel when the client lacks the required agent client.
mustNot:
- Add observer to the channel after capability failure.

## capabilities.events-subscribe-requires-agent-client
Executor: relay
Kind: capability
Tags: capabilities, events, pending-executor
Human Review: true

### Message
Event subscription should require the events.subscribe agent-client capability.

### Mock
```json
{
  "agents": [{ "name": "observer", "type": "agent" }],
  "channels": [{ "name": "general", "members": ["observer"] }],
  "clientCapabilities": { "agentClient": false }
}
```

### Operations
```json
[
  { "op": "add_listener", "as": "observer", "selector": { "type": "messageCreated", "channel": "general" } }
]
```

### Deterministic Checks
must:
- Report a missing event subscription capability.
mustNot:
- Register a live listener when event transport is unavailable.

## capabilities.unsupported-durable-ack-stub
Executor: relay
Kind: regression
Tags: capabilities, durable-delivery, stub, pending-executor
Human Review: true

### Message
Unsupported durable delivery ack should return an explicit unsupported result rather than pretending success.

### Mock
```json
{
  "agents": [{ "name": "observer", "type": "agent" }],
  "messages": [
    { "id": "msg_cap_ack", "channel": "general", "from": "lead", "text": "Ack me" }
  ],
  "deliveryCapabilities": {
    "durableAck": false
  }
}
```

### Operations
```json
[
  { "op": "mark_read", "as": "observer", "messageId": "msg_cap_ack" }
]
```

### Deterministic Checks
must:
- Return an explicit unsupported capability result.
mustNot:
- Report durable ack support when the mock disables it.
