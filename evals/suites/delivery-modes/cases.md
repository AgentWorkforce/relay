# Delivery Modes Cases
Delivery mode cases verify that DeliveryRunner semantics preserve wait versus steer intent, ordered delivery, terminal acknowledgements, and retryable failure behavior.

## delivery-modes.wait-acks-delivered
Executor: relay
Kind: regression
Tags: delivery, wait, ack
Human Review: false

### Message
A queued inbox item is delivered in wait mode and the runner should ack it as delivered.

### Mock
```json
{
  "agents": [{ "name": "worker", "type": "agent" }],
  "inbox": [
    { "id": "in_wait_1", "recipient": "worker", "from": "lead", "text": "Please review the patch" }
  ],
  "delivery": {
    "target": "worker",
    "serverDeliveryState": true,
    "result": { "status": "delivered", "metadata": { "injected": true } }
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
ok: true
contentIncludes:
- delivered
toolCallsInclude:
- deliver
minToolCalls: 1
must:
- Ack inbox item `in_wait_1` with delivered state.
- Preserve delivery result metadata on the ack.
mustNot:
- Mark the item failed or deferred.

## delivery-modes.steer-interrupts-immediately
Executor: relay
Kind: capability
Tags: delivery, steer, interrupt
Human Review: false

### Message
A steer-mode delivery should use an immediate/interrupt injection path for the active agent.

### Mock
```json
{
  "agents": [{ "name": "navigator", "type": "agent" }],
  "inbox": [
    { "id": "in_steer_1", "recipient": "navigator", "from": "lead", "text": "Stop and inspect the failing test now" }
  ],
  "delivery": {
    "target": "navigator",
    "serverDeliveryState": true,
    "result": { "status": "accepted", "metadata": { "mode": "interrupt" } }
  }
}
```

### Operations
```json
[
  { "op": "deliver", "as": "navigator", "mode": "steer", "reason": "mention", "priority": "urgent" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- accepted
- interrupt
toolCallsInclude:
- deliver
must:
- Pass steer intent to the delivery adapter as an interrupt-style context.
- Ack the accepted item without scheduling a retry.
mustNot:
- Treat steer mode as an idle wait.

## delivery-modes.deferred-result-schedules-availability
Executor: relay
Kind: regression
Tags: delivery, defer, backoff
Human Review: false

### Message
When the adapter defers a message, the runner should defer the inbox item until the supplied availability time.

### Mock
```json
{
  "agents": [{ "name": "worker", "type": "agent" }],
  "inbox": [
    { "id": "in_defer_1", "recipient": "worker", "from": "lead", "text": "Handle this after the current task" }
  ],
  "delivery": {
    "target": "worker",
    "serverDeliveryState": true,
    "result": {
      "status": "deferred",
      "availableAt": "2026-05-27T11:00:00.000Z",
      "reason": "busy",
      "metadata": { "queue": "runtime" }
    }
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
ok: true
contentIncludes:
- deferred
- 2026-05-27T11:00:00.000Z
- busy
must:
- Defer inbox item `in_defer_1` with the adapter-provided availability timestamp.
- Preserve defer metadata.
mustNot:
- Ack a deferred item as delivered.
- Mark a deferred item retryable failure.

## delivery-modes.failed-result-terminal
Executor: relay
Kind: regression
Tags: delivery, failure, terminal
Human Review: false

### Message
An adapter-reported failed result should become a terminal non-retryable inbox failure.

### Mock
```json
{
  "agents": [{ "name": "worker", "type": "agent" }],
  "inbox": [
    { "id": "in_fail_1", "recipient": "worker", "from": "lead", "text": "Deliver to unavailable runtime" }
  ],
  "delivery": {
    "target": "worker",
    "serverDeliveryState": true,
    "result": {
      "status": "failed",
      "reason": "runtime rejected message",
      "metadata": { "terminal": true }
    }
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
ok: true
contentIncludes:
- failed
- runtime rejected message
must:
- Fail inbox item `in_fail_1` with retry set to false.
- Include terminal failure metadata.
mustNot:
- Retry adapter-reported failed results.

## delivery-modes.thrown-error-retryable
Executor: relay
Kind: regression
Tags: delivery, retry, error
Human Review: false

### Message
If injection throws, DeliveryRunner should record a retryable failure instead of losing the inbox item.

### Mock
```json
{
  "agents": [{ "name": "worker", "type": "agent" }],
  "inbox": [
    { "id": "in_retry_1", "recipient": "worker", "from": "lead", "text": "Adapter will throw" }
  ],
  "delivery": {
    "target": "worker",
    "serverDeliveryState": true,
    "throws": "adapter unavailable"
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
ok: true
contentIncludes:
- adapter unavailable
must:
- Record a retryable failure for `in_retry_1`.
- Invoke the delivery error hook before failing the item.
mustNot:
- Ack an item whose adapter injection threw.

## delivery-modes.orders-multiple-inbox-items
Executor: relay
Kind: capability
Tags: delivery, ordering
Human Review: false

### Message
Multiple queued inbox items should be delivered in subscription order.

### Mock
```json
{
  "agents": [{ "name": "worker", "type": "agent" }],
  "inbox": [
    { "id": "in_order_1", "recipient": "worker", "from": "lead", "text": "First item" },
    { "id": "in_order_2", "recipient": "worker", "from": "lead", "text": "Second item" }
  ],
  "delivery": {
    "target": "worker",
    "serverDeliveryState": true,
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
ok: true
contentIncludes:
- delivered
must:
- Inject `in_order_1` before `in_order_2`.
- Ack both items after successful delivery.
mustNot:
- Reorder queued inbox items.

## delivery-modes.session-receive-message-contract
Executor: relay
Kind: regression
Tags: delivery, session
Human Review: false

### Message
A delivery target with receiveMessage should receive message-mode context rather than adapter injection context.

### Mock
```json
{
  "agents": [{ "name": "session-worker", "type": "agent" }],
  "inbox": [
    { "id": "in_session_1", "recipient": "session-worker", "from": "lead", "text": "Session delivery" }
  ],
  "delivery": {
    "target": "session-worker",
    "targetKind": "session",
    "serverDeliveryState": true,
    "result": { "status": "delivered", "deliveryId": "del_session_1" }
  }
}
```

### Operations
```json
[
  { "op": "deliver", "as": "session-worker", "mode": "wait", "reason": "mention", "idempotencyKey": "idem-session-1" }
]
```

### Deterministic Checks
ok: true
contentIncludes:
- del_session_1
must:
- Call receiveMessage with a message context and deterministic delivery id.
- Ack the inbox item after a delivered receipt.
mustNot:
- Require an inject method when receiveMessage is present.
